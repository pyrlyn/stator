//! From generated C to a binary: the clang calls, the archives a link owes, and the pool that
//! compiles a split translation unit. `cli/build.ts` is the contract, down to the argument order,
//! which a static link depends on.
const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const fspath = std.fs.path;
const compile_jobs = @import("compile_jobs.zig");
const failure = @import("failure.zig");
const toolchain = @import("toolchain.zig");
const c_compiler = @import("cc.zig");
pub const Compiler = c_compiler.Compiler;
pub const Choice = c_compiler.Choice;
const support = @import("../support/root.zig");
const Reporter = failure.Reporter;
const Error = failure.Error;
const oom = failure.oom;

pub const Flavor = enum {
    default,
    asan,
    intl,

    fn directory(f: Flavor) []const u8 {
        return switch (f) {
            .default => "build",
            .asan => "build-asan",
            .intl => "build-intl",
        };
    }

    fn recipe(f: Flavor) []const u8 {
        return switch (f) {
            .default => "runtime",
            .asan => "runtime-asan",
            .intl => "runtime-intl",
        };
    }
};

pub const Runtime = struct {
    flavor: Flavor,
    root: []const u8,
    include: []const u8,
    lib_dir: []const u8,
    archive: []const u8,

    /// `root` is the runtime package: `STATOR_RUNTIME_ROOT`, or the sibling of the compiler.
    pub fn at(a: Allocator, flavor: Flavor, root: []const u8) Runtime {
        const lib_dir = join(a, &.{ root, flavor.directory() });
        return .{
            .flavor = flavor,
            .root = root,
            .include = join(a, &.{ root, "include" }),
            .lib_dir = lib_dir,
            .archive = join(a, &.{ lib_dir, "libjsrt.a" }),
        };
    }

    pub fn sanitized(r: Runtime) bool {
        return r.flavor == .asan;
    }
};

/// What every step reads from the process. `env` is the merged environment, `.env` included.
pub const Host = struct {
    a: Allocator,
    io: Io,
    env: *const std.process.Environ.Map,
    r: *Reporter,

    pub fn stderr(h: Host, bytes: []const u8) void {
        Io.File.stderr().writeStreamingAll(h.io, bytes) catch {};
    }
};

fn join(a: Allocator, parts: []const []const u8) []const u8 {
    return fspath.join(a, parts) catch oom();
}

pub const exists = support.package_root.exists;

/// The std library's archive, one for every runtime flavor.
pub fn stdArchive(a: Allocator, std_root: []const u8) []const u8 {
    return join(a, &.{ std_root, "build", "libjsrt_std.a" });
}

const sanitizer_flags = [_][]const u8{ "-O1", "-g", "-fsanitize=address,undefined" };

/// Flags the just recipe recorded next to the archive: asking `pkg-config` a second time, in a
/// different environment, could disagree with the objects being linked.
fn extraLinkFlags(a: Allocator, io: Io, runtime: Runtime) []const []const u8 {
    const recorded = join(a, &.{ runtime.lib_dir, "link-flags.txt" });
    const bytes = Io.Dir.cwd().readFileAlloc(io, recorded, a, .unlimited) catch return &.{};
    var flags: std.ArrayList([]const u8) = .empty;
    var it = std.mem.tokenizeAny(u8, bytes, " \t\r\n\x0b\x0c");
    while (it.next()) |flag| flags.append(a, flag) catch oom();
    return flags.items;
}

/// Only `-l` dedups, and order never changes: static archives read in order, and grouping flags
/// have to pass through untouched.
pub fn dedupLinkLibs(a: Allocator, flags: []const []const u8) []const []const u8 {
    var seen: std.StringHashMapUnmanaged(void) = .empty;
    var kept: std.ArrayList([]const u8) = .empty;
    for (flags) |flag| {
        if (std.mem.startsWith(u8, flag, "-l") and flag.len > 2) {
            const entry = seen.getOrPut(a, flag) catch oom();
            if (entry.found_existing) continue;
        }
        kept.append(a, flag) catch oom();
    }
    return kept.items;
}

pub fn systemLinkFlags(a: Allocator, io: Io, runtime: Runtime, extern_flags: []const []const u8) []const []const u8 {
    const recorded = extraLinkFlags(a, io, runtime);
    const all = std.mem.concat(a, []const u8, &.{ recorded, extern_flags }) catch oom();
    return dedupLinkLibs(a, all);
}

/// `explicit` is `--cc` or config `cc`; `CC` and the default are decided here (`cc.zig`).
pub fn chooseCC(h: Host, explicit: ?c_compiler.Choice, runtime: Runtime) Error!c_compiler.Chosen {
    const darwin = builtin.os.tag == .macos;
    const facts: c_compiler.HostFacts = .{ .darwin = darwin, .windows = builtin.os.tag == .windows, .system_clang = darwin and exists(h.io, "/usr/bin/clang") };
    return c_compiler.choose(h.a, explicit, h.env.get("CC"), runtime.sanitized(), facts, MiseClang{ .h = h });
}

/// One `mise which` per process: Test262 builds thousands of programs in one. A failure is not
/// kept, so a `mise install` mid-run is picked up by the next build. The path outlives the build's
/// arena, so it is copied to the page allocator.
var pinned_clang_path: ?[]const u8 = null;

const MiseClang = struct {
    h: Host,

    pub fn path(m: MiseClang) Error![]const u8 {
        if (pinned_clang_path) |known| return known;
        const found = try c_compiler.pinnedClang(m.h.a, m.h.r, probe(m.h, "mise", &c_compiler.pinned_clang_query));
        pinned_clang_path = std.heap.page_allocator.dupe(u8, found) catch oom();
        return pinned_clang_path.?;
    }
};

/// Runs `<program> <args>` with output captured, as `spawnSync` reports it to `cc.ts`.
fn probe(h: Host, program: []const u8, args: []const []const u8) c_compiler.VersionRun {
    const result = runCaptured(h.a, h.io, h.env, withProgram(h.a, program, args)) catch |err| return switch (err) {
        error.FileNotFound => .not_found,
        else => .{ .start_failed = std.fmt.allocPrint(h.a, "spawnSync {s} {s}", .{ program, errnoName(err) }) catch oom() },
    };
    return .{ .exited = .{ .code = if (result.term == .exited) result.term.exited else null, .stdout = result.stdout, .stderr = result.stderr } };
}

/// Runs `<cc> --version` and classifies it, or refuses the choice with STA0022.
pub fn detectCC(h: Host, choice: c_compiler.Choice) Error!Compiler {
    return c_compiler.judge(h.a, h.r, choice, probe(h, choice.command, &.{"--version"}));
}

/// The runtime's recorded flags and the extern surface's, checked against the compiler's family
/// before they are handed to it.
pub fn requireLinkFlagsSupported(h: Host, cc: Compiler, runtime: Runtime, extern_flags: []const []const u8) Error!void {
    const a = h.a;
    const recorded = std.fmt.allocPrint(a, "the runtime archive's {s}", .{join(a, &.{ runtime.lib_dir, "link-flags.txt" })}) catch oom();
    const rebuild = std.fmt.allocPrint(a, "rebuild the runtime with this compiler (`CC={s} pnpm run runtime`) or use clang", .{cc.command}) catch oom();
    try c_compiler.requireFlagsSupported(h.r, cc, extraLinkFlags(a, h.io, runtime), recorded, rebuild);
    try c_compiler.requireFlagsSupported(h.r, cc, extern_flags, "--link or an @statorLink pragma", "drop it there, or use clang");
}

fn optimization(a: Allocator, opt: u8, runtime: Runtime) []const []const u8 {
    if (runtime.sanitized()) return &sanitizer_flags;
    const flag = std.fmt.allocPrint(a, "-O{d}", .{opt}) catch oom();
    return a.dupe([]const u8, &.{flag}) catch oom();
}

fn shakeFlags(runtime: Runtime) []const []const u8 {
    if (runtime.sanitized()) return &.{};
    if (builtin.os.tag == .macos) return &.{"-Wl,-dead_strip"};
    return &.{ "-ffunction-sections", "-fdata-sections", "-Wl,--gc-sections" };
}

pub const LinkLine = struct {
    inputs: []const []const u8,
    out: []const u8,
    opt: u8,
    extern_flags: []const []const u8,
    /// Set exactly when the module graph holds a `std/*` file.
    std_archive: ?[]const u8,
    runtime: Runtime,
};

pub fn linkArguments(a: Allocator, io: Io, l: LinkLine) []const []const u8 {
    var args: std.ArrayList([]const u8) = .empty;
    args.append(a, "-std=c11") catch oom();
    args.appendSlice(a, optimization(a, l.opt, l.runtime)) catch oom();
    args.appendSlice(a, shakeFlags(l.runtime)) catch oom();
    args.appendSlice(a, &.{ "-I", l.runtime.include }) catch oom();
    args.appendSlice(a, l.inputs) catch oom();
    if (l.std_archive) |archive| args.append(a, archive) catch oom();
    args.appendSlice(a, &.{ "-L", l.runtime.lib_dir, "-ljsrt" }) catch oom();
    args.appendSlice(a, systemLinkFlags(a, io, l.runtime, l.extern_flags)) catch oom();
    args.appendSlice(a, &.{ "-o", l.out }) catch oom();
    return args.items;
}

/// `spawnSync` reports a failed start as `spawnSync <cc> <errno name>`, which STA0009 repeats.
fn errnoName(err: anyerror) []const u8 {
    return switch (err) {
        error.AccessDenied => "EACCES",
        error.PermissionDenied => "EPERM",
        error.NotDir => "ENOTDIR",
        error.IsDir => "EISDIR",
        error.SymLinkLoop => "ELOOP",
        error.NameTooLong => "ENAMETOOLONG",
        error.FileBusy => "ETXTBSY",
        error.SystemResources => "ENOMEM",
        error.ProcessFdQuotaExceeded => "EMFILE",
        error.SystemFdQuotaExceeded => "ENFILE",
        error.InvalidExe => "ENOEXEC",
        else => @errorName(err),
    };
}

fn startFailure(h: Host, cc: []const u8, err: anyerror) Error {
    if (err == error.FileNotFound) return h.r.fail("STA0008", "C compiler \"{s}\" not found — install clang (`mise install`, or macOS: `xcode-select --install`; Debian/Ubuntu: `apt install clang`) or set `CC`", .{cc});
    return h.r.fail("STA0009", "C compiler failed to start: spawnSync {s} {s}", .{ cc, errnoName(err) });
}

const Exit = std.process.Child.Term;

fn exitText(a: Allocator, term: Exit) []const u8 {
    return switch (term) {
        .exited => |code| std.fmt.allocPrint(a, "{d}", .{code}) catch oom(),
        else => "signal",
    };
}

fn succeeded(term: Exit) bool {
    return term == .exited and term.exited == 0;
}

/// Inherited stdio, so a failing compile shows its own errors rather than routing them through a
/// diagnostic.
fn runInherited(h: Host, cc: []const u8, args: []const []const u8) Error!Exit {
    const argv = withProgram(h.a, cc, args);
    var child = std.process.spawn(h.io, .{ .argv = argv, .environ_map = h.env, .stdin = .ignore }) catch |err| return startFailure(h, cc, err);
    return child.wait(h.io) catch |err| startFailure(h, cc, err);
}

const Captured = struct { term: Exit, stdout: []const u8, stderr: []const u8 };

fn runCaptured(a: Allocator, io: Io, env: *const std.process.Environ.Map, argv: []const []const u8) anyerror!Captured {
    const result = try std.process.run(a, io, .{ .argv = argv, .environ_map = env });
    return .{ .term = result.term, .stdout = result.stdout, .stderr = result.stderr };
}

fn withProgram(a: Allocator, program: []const u8, args: []const []const u8) []const []const u8 {
    const argv = a.alloc([]const u8, args.len + 1) catch oom();
    argv[0] = program;
    @memcpy(argv[1..], args);
    return argv;
}

/// A zero exit is not proof of an output: a wrapper that swallows the call can succeed and write
/// nothing.
fn requireProduced(h: Host, cc: Compiler, out: []const u8) Error!void {
    if (!exists(h.io, out)) return h.r.fail("STA0009", "C compiler \"{s}\" exited 0 but wrote no \"{s}\" — check that {s} names a working C compiler", .{ cc.command, out, cc.source.describe() });
}

pub fn compileObject(h: Host, cc: Compiler, c_path: []const u8, out: []const u8, opt: u8, runtime: Runtime) Error!void {
    const a = h.a;
    var args: std.ArrayList([]const u8) = .empty;
    args.append(a, "-std=c11") catch oom();
    args.appendSlice(a, optimization(a, opt, runtime)) catch oom();
    args.appendSlice(a, &.{ "-I", runtime.include, "-c", c_path, "-o", out }) catch oom();
    const term = try runInherited(h, cc.command, args.items);
    if (!succeeded(term)) return h.r.fail("STA0009", "C compiler failed (exit {s}) — this is a compiler bug; keep the C with `--keep-c` and report it", .{exitText(a, term)});
    try requireProduced(h, cc, out);
}

pub fn requireArchive(h: Host, what: []const u8, archive: []const u8, root: []const u8, recipe: []const u8) Error!void {
    if (exists(h.io, archive)) return;
    return h.r.fail("STA0011", "{s} archive not found at {s} — run `just -f {s} -d {s} {s}`", .{ what, archive, join(h.a, &.{ root, "justfile" }), root, recipe });
}

pub const Archives = struct {
    runtime: Runtime,
    /// `(archive, package root)` of the std library, when the program imports it.
    std_lib: ?struct { archive: []const u8, root: []const u8 } = null,
};

pub fn requireLinkArchives(h: Host, archives: Archives) Error!void {
    const runtime = archives.runtime;
    try requireArchive(h, "runtime", runtime.archive, runtime.root, runtime.flavor.recipe());
    if (archives.std_lib) |s| try requireArchive(h, "std", s.archive, s.root, "std");
}

/// A failed link with extern flags is usually a missing library rather than a compiler bug, so
/// the flags are named. `hint` rides along only for the stale-linker signature, whose raw `ld`
/// output names a format the user cannot act on.
fn linkFailure(h: Host, extern_flags: []const []const u8, term: Exit, hint: ?[]const u8) Error {
    const a = h.a;
    const where = std.fmt.allocPrint(a, "C compiler failed (exit {s})", .{exitText(a, term)}) catch oom();
    const tail = if (hint) |text|
        std.fmt.allocPrint(a, "{s}; otherwise keep the C with `--keep-c` and report it", .{text}) catch oom()
    else
        "keep the C with `--keep-c` and report it";
    if (extern_flags.len > 0) {
        const flags = std.mem.join(a, " ", extern_flags) catch oom();
        return h.r.fail("STA0009", "{s} with extern link flags {s} — if a flag names a library that is not installed, install it or fix the @statorLink pragma / --link= value; {s}", .{ where, flags, tail });
    }
    return h.r.fail("STA0009", "{s} — this is a compiler bug; {s}", .{ where, tail });
}

/// Captured, so the failure can be classified before anything is printed; replayed on failure.
pub fn link(h: Host, cc: Compiler, l: LinkLine, archives: Archives) Error!void {
    try requireLinkArchives(h, archives);
    try requireLinkFlagsSupported(h, cc, l.runtime, l.extern_flags);
    const a = h.a;
    const args = linkArguments(a, h.io, l);
    const first = runCaptured(a, h.io, h.env, withProgram(a, cc.command, args)) catch |err| return startFailure(h, cc.command, err);
    if (succeeded(first.term)) return requireProduced(h, cc, l.out);

    // A stale bundled linker against a newer Xcode SDK fails every Darwin link, even `int main`.
    const stale = toolchain.isStaleLdSystemLibFailure(first.stderr);
    const retryable = stale and builtin.os.tag == .macos and cc.source == .default and !l.runtime.sanitized();
    if (retryable) if (toolchain.findFallbackSdk(a, h.io, toolchain.clt_sdk_root)) |sysroot| {
        const retry = std.mem.concat(a, []const u8, &.{ args, &.{ "-isysroot", sysroot } }) catch oom();
        const second = runCaptured(a, h.io, h.env, withProgram(a, cc.command, retry)) catch |err| return startFailure(h, cc.command, err);
        if (succeeded(second.term)) return requireProduced(h, cc, l.out);
        h.stderr(second.stdout);
        h.stderr(second.stderr);
        return linkFailure(h, l.extern_flags, second.term, toolchain.staleLdHint(a, sysroot));
    };
    h.stderr(first.stdout);
    h.stderr(first.stderr);
    return linkFailure(h, l.extern_flags, first.term, if (stale) toolchain.staleLdHint(a, null) else null);
}

/// One unit's fate. Each slot belongs to the one worker that claimed its index.
const UnitResult = union(enum) {
    pending,
    ok,
    start_failed: anyerror,
    exited: Exit,
    missing,
};

const Pool = struct {
    h: Host,
    cc: Compiler,
    prefix: []const []const u8,
    units: []const compile_jobs.Unit,
    paths: []const []const u8,
    objects: []const []const u8,
    results: []UnitResult,
    cursor: std.atomic.Value(usize) = .init(0),
    /// `units.len` until a unit fails: the index of the first failure in time.
    first_failure: std.atomic.Value(usize),

    fn work(p: *Pool) void {
        // Each worker keeps its own arena: the caller's is not thread-safe.
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const a = arena.allocator();
        while (p.first_failure.load(.acquire) == p.units.len) {
            const i = p.cursor.fetchAdd(1, .acq_rel);
            if (i >= p.units.len) return;
            p.results[i] = p.compile(a, i);
            if (p.results[i] != .ok) _ = p.first_failure.cmpxchgStrong(p.units.len, i, .acq_rel, .acquire);
            _ = arena.reset(.retain_capacity);
        }
    }

    fn compile(p: *Pool, a: Allocator, i: usize) UnitResult {
        const argv = std.mem.concat(a, []const u8, &.{ &.{p.cc.command}, p.prefix, &.{ p.paths[i], "-o", p.objects[i] } }) catch oom();
        const result = runCaptured(a, p.h.io, p.h.env, argv) catch |err| return .{ .start_failed = err };
        if (!succeeded(result.term)) {
            p.h.stderr(result.stdout);
            p.h.stderr(result.stderr);
            return .{ .exited = result.term };
        }
        return if (exists(p.h.io, p.objects[i])) .ok else .missing;
    }
};

/// Workers finish what they started before the first failure is reported: no clang child is left
/// behind, and no later unit starts.
pub fn linkParallel(h: Host, cc: Compiler, c: []const u8, parts_dir: []const u8, l: LinkLine, archives: Archives, jobs: usize) Error!void {
    const a = h.a;
    const parts = compile_jobs.partition(a, c, jobs) catch |err| switch (err) {
        error.Unclosed => return h.r.fail("STA4072", "internal error: the emitted C has an unclosed definition — this is a compiler bug; report it with the input that triggered it", .{}),
    };
    try writeScratch(h, join(a, &.{ parts_dir, parts.header_name }), parts.header);
    const paths = a.alloc([]const u8, parts.units.len) catch oom();
    const objects = a.alloc([]const u8, parts.units.len) catch oom();
    for (parts.units, 0..) |unit, i| {
        paths[i] = join(a, &.{ parts_dir, unit.name });
        const stem = if (std.mem.endsWith(u8, paths[i], ".c")) paths[i][0 .. paths[i].len - 2] else paths[i];
        objects[i] = std.mem.concat(a, u8, &.{ stem, ".o" }) catch oom();
        try writeScratch(h, paths[i], unit.source);
    }
    var prefix: std.ArrayList([]const u8) = .empty;
    prefix.append(a, "-std=c11") catch oom();
    prefix.appendSlice(a, optimization(a, l.opt, l.runtime)) catch oom();
    prefix.appendSlice(a, &.{ "-I", l.runtime.include, "-c" }) catch oom();

    const results = a.alloc(UnitResult, parts.units.len) catch oom();
    @memset(results, .pending);
    var pool: Pool = .{
        .h = h,
        .cc = cc,
        .prefix = prefix.items,
        .units = parts.units,
        .paths = paths,
        .objects = objects,
        .results = results,
        .first_failure = .init(parts.units.len),
    };
    const width = @max(1, @min(jobs, parts.units.len));
    const threads = a.alloc(std.Thread, width - 1) catch oom();
    var started: usize = 0;
    // A thread that cannot start only narrows the pool: the calling thread still drains it.
    for (threads) |*t| {
        t.* = std.Thread.spawn(.{}, Pool.work, .{&pool}) catch break;
        started += 1;
    }
    pool.work();
    for (threads[0..started]) |t| t.join();

    const failed = pool.first_failure.load(.acquire);
    if (failed != parts.units.len) switch (results[failed]) {
        .start_failed => |err| return startFailure(h, cc.command, err),
        .exited => |term| return h.r.fail("STA0009", "C compiler failed (exit {s} on {s}) — this is a compiler bug; keep the C with `--keep-c` and report it", .{ exitText(a, term), parts.units[failed].name }),
        .missing => return requireProduced(h, cc, objects[failed]),
        .pending, .ok => unreachable,
    };
    var linked = l;
    linked.inputs = objects;
    return link(h, cc, linked, archives);
}

/// A scratch file is ours, in a directory we just made, so failing to write it is no user error.
pub fn writeScratch(h: Host, path: []const u8, bytes: []const u8) Error!void {
    Io.Dir.cwd().writeFile(h.io, .{ .sub_path = path, .data = bytes }) catch |err|
        return h.r.fail("STA4072", "internal error: cannot write {s}: {s} — this is a compiler bug; report it with the input that triggered it", .{ path, @errorName(err) });
}

/// `os.tmpdir()`: the same three variables, a trailing separator dropped.
pub fn tmpDir(env: *const std.process.Environ.Map) []const u8 {
    const base = env.get("TMPDIR") orelse env.get("TMP") orelse env.get("TEMP") orelse "/tmp";
    if (base.len > 1 and base[base.len - 1] == '/') return base[0 .. base.len - 1];
    return base;
}

const random_alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/// `mkdtempSync(join(tmpdir(), prefix))`.
pub fn makeTempDir(h: Host, prefix: []const u8) Error![]const u8 {
    const a = h.a;
    var attempts: usize = 0;
    while (attempts < 16) : (attempts += 1) {
        var suffix: [6]u8 = undefined;
        h.io.random(&suffix);
        for (&suffix) |*b| b.* = random_alphabet[b.* % random_alphabet.len];
        const name = std.mem.concat(a, u8, &.{ prefix, &suffix }) catch oom();
        const path = join(a, &.{ tmpDir(h.env), name });
        Io.Dir.cwd().createDir(h.io, path, .fromMode(0o700)) catch |err| switch (err) {
            error.PathAlreadyExists => continue,
            else => return h.r.fail("STA4072", "internal error: cannot create a temporary directory {s}: {s} — this is a compiler bug; report it with the input that triggered it", .{ path, @errorName(err) }),
        };
        return path;
    }
    return h.r.fail("STA4072", "internal error: cannot create a temporary directory under {s} — this is a compiler bug; report it with the input that triggered it", .{tmpDir(h.env)});
}

pub fn removeTree(io: Io, path: []const u8) void {
    Io.Dir.cwd().deleteTree(io, path) catch {};
}

test {
    std.testing.refAllDecls(@This());
}

test "dedupLinkLibs keeps the first of each library and every other flag" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const kept = dedupLinkLibs(arena.allocator(), &.{ "-lz", "-L/x", "-L/x", "-lm", "-lz", "-l", "-l" });
    try std.testing.expectEqual(@as(usize, 6), kept.len);
    try std.testing.expectEqualStrings("-lm", kept[3]);
    try std.testing.expectEqualStrings("-l", kept[5]);
}

test "the link line reads archives in the one order that links" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const runtime = Runtime.at(a, .default, "/nonexistent-stator/runtime");
    const args = linkArguments(a, std.testing.io, .{ .inputs = &.{"m.c"}, .out = "app", .opt = 2, .extern_flags = &.{ "-lz", "-lz" }, .std_archive = "/s/libjsrt_std.a", .runtime = runtime });
    const joined = try std.mem.join(a, " ", args);
    const expected = if (builtin.os.tag == .macos)
        "-std=c11 -O2 -Wl,-dead_strip -I /nonexistent-stator/runtime/include m.c /s/libjsrt_std.a -L /nonexistent-stator/runtime/build -ljsrt -lz -o app"
    else
        "-std=c11 -O2 -ffunction-sections -fdata-sections -Wl,--gc-sections -I /nonexistent-stator/runtime/include m.c /s/libjsrt_std.a -L /nonexistent-stator/runtime/build -ljsrt -lz -o app";
    try std.testing.expectEqualStrings(expected, joined);
}

test "a sanitized link takes the sanitizer flags and no dead stripping" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const runtime = Runtime.at(a, .asan, "/r");
    const args = linkArguments(a, std.testing.io, .{ .inputs = &.{"m.c"}, .out = "app", .opt = 2, .extern_flags = &.{}, .std_archive = null, .runtime = runtime });
    const joined = try std.mem.join(a, " ", args);
    try std.testing.expectEqualStrings("-std=c11 -O1 -g -fsanitize=address,undefined -I /r/include m.c -L /r/build-asan -ljsrt -o app", joined);
}
