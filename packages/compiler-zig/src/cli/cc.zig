//! The C compiler a build runs (`src/cli/cc.ts`, plan/T35): one resolver, one `--version` probe,
//! one flag table. Precedence: `--cc` > `CC` > config `cc` > the default (plan-notes 409), which
//! is the clang mise pins, never whichever `clang` PATH finds first (plan-notes 410). Every failure
//! is `STA0022`, naming the value, where it came from and how to choose another.
const std = @import("std");
const Allocator = std.mem.Allocator;
const js_text = @import("jstext");
const failure = @import("failure.zig");
const Reporter = failure.Reporter;
const Error = failure.Error;
const oom = failure.oom;

pub const Source = enum {
    flag,
    config,
    env,
    default,

    /// How a diagnostic names where the value came from.
    pub fn describe(s: Source) []const u8 {
        return switch (s) {
            .flag => "--cc",
            .config => "config \"cc\"",
            .env => "CC",
            .default => "the default",
        };
    }
};

pub const Choice = struct { command: []const u8, source: Source };

pub const Family = enum {
    clang,
    apple_clang,
    gcc,

    pub fn name(f: Family) []const u8 {
        return switch (f) {
            .clang => "clang",
            .apple_clang => "apple-clang",
            .gcc => "gcc",
        };
    }
};

pub const Compiler = struct { command: []const u8, source: Source, family: Family };

/// mise.toml's `conda:clang` pin. statorc runs outside a Stator checkout too, where mise.toml is
/// not there to read, so the version lives here and `cc.test.ts` fails when the two drift.
pub const pinned_clang_tool = "conda:clang@21.1.8";

/// The default on Windows, where mise.toml pins no clang: the `clang` on PATH.
pub const windows_default_cc = "clang";

/// The arguments that ask mise for the pinned clang's absolute path.
pub const pinned_clang_query = [_][]const u8{ "which", "clang", "--tool", pinned_clang_tool };

const choose_another = "choose another with --cc=<name|path>, config \"cc\" or CC";
const fix = choose_another ++ " (unset all three for the default clang)";

pub const HostFacts = struct { darwin: bool, windows: bool, system_clang: bool };

pub const Chosen = struct { choice: Choice, warning: ?[]const u8 = null };

/// `explicit` is `--cc` or config `cc`; `CC` sits between them, and an empty `CC` is unset.
///
/// conda-clang 21.1.8's Darwin ASan runtime deadlocks during dyld's early malloc initialization,
/// so a sanitized build on macOS defaults to `/usr/bin/clang`, as the runtime justfile does. An
/// explicit choice is never second-guessed: it may be the toolchain under test.
///
/// `pinned.path()` gives the pinned clang's path, or fails; it is called only when the default is
/// the pinned clang, so an explicit choice never needs mise.
pub fn choose(a: Allocator, explicit: ?Choice, env_cc: ?[]const u8, sanitized: bool, host: HostFacts, pinned: anytype) Error!Chosen {
    const from_env: ?Choice = if (env_cc) |v| (if (v.len == 0) null else .{ .command = v, .source = .env }) else null;
    const picked: ?Choice = if (explicit != null and explicit.?.source == .flag) explicit else from_env orelse explicit;
    const overridden = sanitized and host.darwin and host.system_clang;
    const choice = picked orelse {
        const command = if (overridden) "/usr/bin/clang" else if (host.windows) windows_default_cc else try pinned.path();
        return .{ .choice = .{ .command = command, .source = .default } };
    };
    if (!overridden) return .{ .choice = choice };
    return .{
        .choice = choice,
        .warning = std.fmt.allocPrint(a, "C compiler \"{s}\" (from {s}) is used under the ASan runtime instead of /usr/bin/clang; conda clang 21.1.8 deadlocks there at startup", .{ choice.command, choice.source.describe() }) catch oom(),
    };
}

fn isWord(b: u8) bool {
    return std.ascii.isAlphanumeric(b) or b == '_';
}

fn isLineTerminator(cp: u21) bool {
    return cp == '\n' or cp == '\r' or cp == 0x2028 or cp == 0x2029;
}

/// The lines `^` and `.` see under the `m` flag.
const Lines = struct {
    it: js_text.CodePoints,
    start: usize = 0,
    done: bool = false,

    fn init(text: []const u8) Lines {
        return .{ .it = .{ .bytes = text } };
    }

    fn next(l: *Lines) ?[]const u8 {
        if (l.done) return null;
        while (l.it.next()) |c| {
            if (!isLineTerminator(c.cp)) continue;
            const line = l.it.bytes[l.start..c.start];
            l.start = c.end;
            return line;
        }
        l.done = true;
        return l.it.bytes[l.start..];
    }
};

/// `/\bclang version \d/`
fn namesClang(text: []const u8) bool {
    const needle = "clang version ";
    var from: usize = 0;
    while (std.mem.indexOfPos(u8, text, from, needle)) |i| : (from = i + 1) {
        const bounded = i == 0 or !isWord(text[i - 1]);
        const digit = i + needle.len < text.len and std.ascii.isDigit(text[i + needle.len]);
        if (bounded and digit) return true;
    }
    return false;
}

/// `/\bg?cc(-\d+)? \(.*\) \d/` from `at`, which `\S*` reached from the line's start.
fn gccBannerAt(line: []const u8, at: usize) bool {
    if (at != 0 and isWord(line[at - 1])) return false;
    var q = at;
    if (std.mem.startsWith(u8, line[q..], "gcc")) q += 3 else if (std.mem.startsWith(u8, line[q..], "cc")) q += 2 else return false;
    if (q + 1 < line.len and line[q] == '-' and std.ascii.isDigit(line[q + 1])) {
        q += 1;
        while (q < line.len and std.ascii.isDigit(line[q])) q += 1;
    }
    if (!std.mem.startsWith(u8, line[q..], " (")) return false;
    var from = q + 2;
    while (std.mem.indexOfPos(u8, line, from, ") ")) |j| : (from = j + 1) {
        if (j + 2 < line.len and std.ascii.isDigit(line[j + 2])) return true;
    }
    return false;
}

/// `/^\S*\bg?cc(-\d+)? \(.*\) \d/m`
fn gccBanner(text: []const u8) bool {
    var lines = Lines.init(text);
    while (lines.next()) |line| {
        var it: js_text.CodePoints = .{ .bytes = line };
        while (it.next()) |c| {
            if (gccBannerAt(line, c.start)) return true;
            if (js_text.isSpace(c.cp)) break;
        }
    }
    return false;
}

/// The family a `--version` text names, or null for one Stator does not know. `zig cc` prints
/// clang's banner, and is clang.
pub fn classify(version: []const u8) ?Family {
    var lines = Lines.init(version);
    while (lines.next()) |line| if (std.mem.startsWith(u8, line, "Apple clang version ")) return .apple_clang;
    if (namesClang(version)) return .clang;
    if (std.mem.indexOf(u8, version, "Free Software Foundation") != null or gccBanner(version)) return .gcc;
    return null;
}

/// How `<cc> --version` went. `start_failed` carries `spawnSync`'s message.
pub const VersionRun = union(enum) {
    not_found,
    start_failed: []const u8,
    exited: struct { code: ?u32, stdout: []const u8, stderr: []const u8 = "" },
};

/// The pinned clang's path from a `mise which` run (made by the caller), or STA0022 when mise is
/// missing or the tool is not installed. No fallback to another clang: a build that silently used
/// a different compiler would not be the build the project tested.
pub fn pinnedClang(a: Allocator, r: *Reporter, run: VersionRun) Error![]const u8 {
    const why = switch (run) {
        .not_found => "mise is not on PATH",
        .start_failed => |message| miseFailed(a, message),
        .exited => |e| why: {
            const path = js_text.trim(e.stdout);
            if (e.code != null and e.code.? == 0 and path.len != 0) return path;
            break :why miseFailed(a, miseError(e.stderr) orelse exitText(a, e.code));
        },
    };
    return r.fail("STA0022", "the default C compiler, mise's pinned LLVM clang (" ++ pinned_clang_tool ++ "), is unavailable: {s} — run `mise install` in the Stator checkout, or " ++ choose_another, .{why});
}

fn miseFailed(a: Allocator, reason: []const u8) []const u8 {
    return std.fmt.allocPrint(a, "`mise {s} {s} {s} {s}` failed ({s})", .{ pinned_clang_query[0], pinned_clang_query[1], pinned_clang_query[2], pinned_clang_query[3], reason }) catch oom();
}

/// mise's own reason, e.g. `conda:clang@21.1.8 is not installed`: its first ERROR line, since
/// update notices and hints come on stderr too.
fn miseError(stderr: []const u8) ?[]const u8 {
    const marker = "ERROR ";
    var lines = std.mem.splitScalar(u8, stderr, '\n');
    while (lines.next()) |line| if (std.mem.indexOf(u8, line, marker)) |i| return js_text.trim(line[i + marker.len ..]);
    return null;
}

fn exitText(a: Allocator, code: ?u32) []const u8 {
    return if (code) |c| std.fmt.allocPrint(a, "exit {d}", .{c}) catch oom() else "exit signal";
}

/// Classifies a probe's result, or refuses the choice.
pub fn judge(a: Allocator, r: *Reporter, choice: Choice, run: VersionRun) Error!Compiler {
    const named = std.fmt.allocPrint(a, "C compiler \"{s}\" (from {s})", .{ choice.command, choice.source.describe() }) catch oom();
    const stdout = switch (run) {
        .not_found => return r.fail("STA0022", "{s} not found — install it (clang: `mise install`, macOS: `xcode-select --install`, Debian/Ubuntu: `apt install clang`), or " ++ fix, .{named}),
        .start_failed => |why| return r.fail("STA0022", "{s} failed `--version` ({s}) — " ++ fix, .{ named, why }),
        .exited => |e| if (e.code) |code| (if (code == 0) e.stdout else return r.fail("STA0022", "{s} failed `--version` (exit {d}) — " ++ fix, .{ named, code })) else return r.fail("STA0022", "{s} failed `--version` (exit signal) — " ++ fix, .{named}),
    };
    const family = classify(stdout) orelse {
        const end = std.mem.indexOfScalar(u8, stdout, '\n') orelse stdout.len;
        return r.fail("STA0022", "{s} is not clang, Apple clang or gcc: `--version` printed \"{s}\" — " ++ fix, .{ named, js_text.trim(stdout[0..end]) });
    };
    return .{ .command = choice.command, .source = choice.source, .family = family };
}

/// Flags a family lacks, by exact spelling. Everything else Stator passes (`-std=c11`, `-O<n>`,
/// `-g`, `-fsanitize=address,undefined`, the section and dead-strip flags) all three accept.
const Refused = struct { flag: []const u8, why: []const u8 };

fn refused(family: Family) []const Refused {
    return switch (family) {
        .clang, .apple_clang => &.{},
        .gcc => &.{.{ .flag = "-flto=thin", .why = "ThinLTO is LLVM-only, and the objects it made are LLVM bitcode" }},
    };
}

/// Refuses, by name, a flag `cc`'s family lacks instead of handing it over. `origin` says where
/// the flag came from and `remedy` how to drop it.
pub fn requireFlagsSupported(r: *Reporter, cc: Compiler, flags: []const []const u8, origin: []const u8, remedy: []const u8) Error!void {
    for (flags) |flag| for (refused(cc.family)) |entry| if (std.mem.eql(u8, flag, entry.flag)) {
        return r.fail("STA0022", "C compiler \"{s}\" ({s}, from {s}) does not take {s}, which {s} asks for ({s}) — {s}", .{ cc.command, cc.family.name(), cc.source.describe(), flag, origin, entry.why, remedy });
    };
}

const testing = std.testing;
const linux: HostFacts = .{ .darwin = false, .windows = false, .system_clang = false };
const mac: HostFacts = .{ .darwin = true, .windows = false, .system_clang = true };
const windows: HostFacts = .{ .darwin = false, .windows = true, .system_clang = false };
const mise_clang = "/mise/installs/conda-clang/21.1.8/.mise-bins/clang";

const Pinned = struct {
    fn path(_: Pinned) Error![]const u8 {
        return mise_clang;
    }
};

/// A default that must not ask mise: an explicit choice, Windows or the macOS ASan override.
const Unreachable = struct {
    fn path(_: Unreachable) Error![]const u8 {
        unreachable;
    }
};

test "--cc beats CC, CC beats config cc and the default, empty CC is unset" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const flag: Choice = .{ .command = "gcc-14", .source = .flag };
    const config: Choice = .{ .command = "gcc-13", .source = .config };
    try testing.expectEqualDeep(flag, (try choose(a, flag, "cc", false, linux, Unreachable{})).choice);
    try testing.expectEqualDeep(Choice{ .command = "cc", .source = .env }, (try choose(a, config, "cc", false, linux, Unreachable{})).choice);
    try testing.expectEqualDeep(config, (try choose(a, config, "", false, linux, Unreachable{})).choice);
    try testing.expectEqualDeep(config, (try choose(a, config, null, false, linux, Unreachable{})).choice);
    try testing.expectEqualDeep(Choice{ .command = mise_clang, .source = .default }, (try choose(a, null, "", false, linux, Pinned{})).choice);
}

test "the default is mise's clang, PATH's clang on Windows" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings(mise_clang, (try choose(a, null, null, false, mac, Pinned{})).choice.command);
    try testing.expectEqualStrings("clang", (try choose(a, null, null, false, windows, Unreachable{})).choice.command);
    try testing.expectEqualStrings("clang", (try choose(a, null, null, true, windows, Unreachable{})).choice.command);
}

test "the macOS ASan override applies to the default only; an explicit choice warns" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualDeep(Chosen{ .choice = .{ .command = "/usr/bin/clang", .source = .default } }, try choose(a, null, null, true, mac, Unreachable{}));
    try testing.expectEqualStrings(mise_clang, (try choose(a, null, null, true, linux, Pinned{})).choice.command);
    const explicit = try choose(a, null, "clang", true, mac, Unreachable{});
    try testing.expectEqualStrings("clang", explicit.choice.command);
    try testing.expectEqualStrings("C compiler \"clang\" (from CC) is used under the ASan runtime instead of /usr/bin/clang; conda clang 21.1.8 deadlocks there at startup", explicit.warning.?);
    try testing.expect((try choose(a, null, "clang", false, mac, Unreachable{})).warning == null);
}

test "the pinned clang is mise's answer, or STA0022 naming why" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var r: Reporter = .{ .a = a };
    try testing.expectEqualStrings(mise_clang, try pinnedClang(a, &r, .{ .exited = .{ .code = 0, .stdout = mise_clang ++ "\n" } }));
    const unavailable = "the default C compiler, mise's pinned LLVM clang (conda:clang@21.1.8), is unavailable: ";
    const remedy = " — run `mise install` in the Stator checkout, or choose another with --cc=<name|path>, config \"cc\" or CC";
    try expectRefusal(pinnedClang(a, &r, .not_found), &r, unavailable ++ "mise is not on PATH" ++ remedy);
    try expectRefusal(pinnedClang(a, &r, .{ .exited = .{ .code = 1, .stdout = "", .stderr = "mise WARN  update available\nmise ERROR conda:clang@21.1.8 is not installed\nmise ERROR Run with --verbose\n" } }), &r, unavailable ++ "`mise which clang --tool conda:clang@21.1.8` failed (conda:clang@21.1.8 is not installed)" ++ remedy);
    try expectRefusal(pinnedClang(a, &r, .{ .exited = .{ .code = 0, .stdout = "\n" } }), &r, unavailable ++ "`mise which clang --tool conda:clang@21.1.8` failed (exit 0)" ++ remedy);
    try expectRefusal(pinnedClang(a, &r, .{ .start_failed = "spawnSync mise EACCES" }), &r, unavailable ++ "`mise which clang --tool conda:clang@21.1.8` failed (spawnSync mise EACCES)" ++ remedy);
}

test "--version banners classify into clang, apple-clang and gcc" {
    try testing.expectEqual(Family.clang, classify("clang version 21.1.8\nTarget: arm64-apple-darwin25").?);
    try testing.expectEqual(Family.clang, classify("Ubuntu clang version 18.1.3 (1ubuntu1)\nTarget: x86_64-pc-linux-gnu").?);
    try testing.expectEqual(Family.apple_clang, classify("Apple clang version 17.0.0 (clang-1700.0.13.5)\nTarget: arm64").?);
    try testing.expectEqual(Family.gcc, classify("gcc (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0\nCopyright (C) 2023 Free Software Foundation, Inc.").?);
    try testing.expectEqual(Family.gcc, classify("cc (Debian 12.2.0-14) 12.2.0\n").?);
    try testing.expectEqual(Family.gcc, classify("x\r/opt/x86_64-linux-gnu-gcc-13 (GCC) 13.2.0").?);
    try testing.expect(classify("tcc version 0.9.27 (x86_64 Linux)") == null);
    try testing.expect(classify("myclang version 1") == null);
    try testing.expect(classify("gccx (A) 1") == null);
    try testing.expect(classify("a gcc (A) 1") == null);
    try testing.expect(classify("") == null);
}

fn expectRefusal(result: anytype, r: *const Reporter, message: []const u8) !void {
    try testing.expectError(error.Failed, result);
    try testing.expectEqualStrings("STA0022", r.failure.?.code);
    try testing.expectEqualStrings(message, r.failure.?.message);
}

test "the probe refuses a missing binary, a failing one and an unknown family" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var r: Reporter = .{ .a = a };
    try expectRefusal(judge(a, &r, .{ .command = "nope", .source = .flag }, .not_found), &r, "C compiler \"nope\" (from --cc) not found — install it (clang: `mise install`, macOS: `xcode-select --install`, Debian/Ubuntu: `apt install clang`), or " ++ fix);
    try expectRefusal(judge(a, &r, .{ .command = "/usr/bin/false", .source = .env }, .{ .exited = .{ .code = 1, .stdout = "" } }), &r, "C compiler \"/usr/bin/false\" (from CC) failed `--version` (exit 1) — " ++ fix);
    try expectRefusal(judge(a, &r, .{ .command = "x", .source = .env }, .{ .start_failed = "spawnSync x EACCES" }), &r, "C compiler \"x\" (from CC) failed `--version` (spawnSync x EACCES) — " ++ fix);
    try expectRefusal(judge(a, &r, .{ .command = "odd", .source = .config }, .{ .exited = .{ .code = 0, .stdout = " Odd C 1.0 \nmore" } }), &r, "C compiler \"odd\" (from config \"cc\") is not clang, Apple clang or gcc: `--version` printed \"Odd C 1.0\" — " ++ fix);
    const gcc = try judge(a, &r, .{ .command = "gcc", .source = .default }, .{ .exited = .{ .code = 0, .stdout = "gcc (GCC) 14.2.0\n" } });
    try testing.expectEqual(Family.gcc, gcc.family);
}

test "gcc refuses -flto=thin by name; clang takes it" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var r: Reporter = .{ .a = arena.allocator() };
    const gcc: Compiler = .{ .command = "gcc", .source = .env, .family = .gcc };
    try expectRefusal(requireFlagsSupported(&r, gcc, &.{ "-lm", "-flto=thin" }, "link-flags.txt", "rebuild it"), &r, "C compiler \"gcc\" (gcc, from CC) does not take -flto=thin, which link-flags.txt asks for (ThinLTO is LLVM-only, and the objects it made are LLVM bitcode) — rebuild it");
    try requireFlagsSupported(&r, .{ .command = "clang", .source = .default, .family = .clang }, &.{"-flto=thin"}, "x", "y");
}
