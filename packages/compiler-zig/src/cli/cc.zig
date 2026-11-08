//! The C compiler a build runs (`src/cli/cc.ts`, plan/T35): one resolver, one `--version` probe,
//! one flag table. Precedence: `--cc` > `CC` > config `cc` > `clang` (plan-notes 409). Every
//! failure is `STA0022`, naming the value, where it came from and how to choose another.
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

pub const default_cc = "clang";

const fix = "choose another with --cc=<name|path>, config \"cc\" or CC (unset all three for the default clang)";

pub const HostFacts = struct { darwin: bool, system_clang: bool };

pub const Chosen = struct { choice: Choice, warning: ?[]const u8 = null };

/// `explicit` is `--cc` or config `cc`; `CC` sits between them, and an empty `CC` is unset.
///
/// conda-clang 21.1.8's Darwin ASan runtime deadlocks during dyld's early malloc initialization,
/// so a sanitized build on macOS defaults to `/usr/bin/clang`, as the runtime justfile does. An
/// explicit choice is never second-guessed: it may be the toolchain under test.
pub fn choose(a: Allocator, explicit: ?Choice, env_cc: ?[]const u8, sanitized: bool, host: HostFacts) Chosen {
    const from_env: ?Choice = if (env_cc) |v| (if (v.len == 0) null else .{ .command = v, .source = .env }) else null;
    const picked: ?Choice = if (explicit != null and explicit.?.source == .flag) explicit else from_env orelse explicit;
    const overridden = sanitized and host.darwin and host.system_clang;
    const choice = picked orelse return .{ .choice = .{ .command = if (overridden) "/usr/bin/clang" else default_cc, .source = .default } };
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
    exited: struct { code: ?u32, stdout: []const u8 },
};

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
const linux: HostFacts = .{ .darwin = false, .system_clang = false };
const mac: HostFacts = .{ .darwin = true, .system_clang = true };

test "--cc beats CC, CC beats config cc and the default, empty CC is unset" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const flag: Choice = .{ .command = "gcc-14", .source = .flag };
    const config: Choice = .{ .command = "gcc-13", .source = .config };
    try testing.expectEqualDeep(flag, choose(a, flag, "cc", false, linux).choice);
    try testing.expectEqualDeep(Choice{ .command = "cc", .source = .env }, choose(a, config, "cc", false, linux).choice);
    try testing.expectEqualDeep(config, choose(a, config, "", false, linux).choice);
    try testing.expectEqualDeep(config, choose(a, config, null, false, linux).choice);
    try testing.expectEqualDeep(Choice{ .command = "clang", .source = .default }, choose(a, null, "", false, linux).choice);
}

test "the macOS ASan override applies to the default only; an explicit choice warns" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualDeep(Chosen{ .choice = .{ .command = "/usr/bin/clang", .source = .default } }, choose(a, null, null, true, mac));
    try testing.expectEqualStrings("clang", choose(a, null, null, true, linux).choice.command);
    try testing.expectEqualStrings("clang", choose(a, null, null, false, mac).choice.command);
    const explicit = choose(a, null, "clang", true, mac);
    try testing.expectEqualStrings("clang", explicit.choice.command);
    try testing.expectEqualStrings("C compiler \"clang\" (from CC) is used under the ASan runtime instead of /usr/bin/clang; conda clang 21.1.8 deadlocks there at startup", explicit.warning.?);
    try testing.expect(choose(a, null, "clang", false, mac).warning == null);
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
