//! Test262's `test/language/` through the interpreter's parse entry (plan T14.1). A test whose
//! metadata says `negative: phase: parse` must be a `SyntaxError`; every other test must parse,
//! in each mode its flags ask for: the module goal for `module`, the source as it is for `raw` and
//! `noStrict`, with `"use strict";` before it for `onlyStrict`, and both otherwise. Pass counts per
//! directory are ratcheted against `test262-parse.json` in the package; `--update` records them.
//!
//! test262-parse --package=<dir> [--corpus=<dir>] [--filter=<text>] [--failures] [--update]
//! The corpus defaults to `$STATOR_TEST262`, then to `packages/tests/test262/corpus`, where
//! `pnpm run test262:fetch` puts the pinned one.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const parse = @import("stator_interp").parse;

const Meta = struct {
    negative_parse: bool = false,
    module: bool = false,
    only_strict: bool = false,
    no_strict: bool = false,
    raw: bool = false,
};

/// The YAML between `/*---` and `---*/`, read only as far as the keys that decide a parse.
fn readMeta(src: []const u8) Meta {
    var m: Meta = .{};
    const open = std.mem.indexOf(u8, src, "/*---") orelse return m;
    const close = std.mem.indexOfPos(u8, src, open, "---*/") orelse return m;
    var block: enum { none, negative, flags } = .none;
    var lines = std.mem.splitScalar(u8, src[open + "/*---".len .. close], '\n');
    while (lines.next()) |line| {
        const text = std.mem.trim(u8, line, " \t\r");
        if (text.len == 0) continue;
        const indented = line[0] == ' ' or line[0] == '\t';
        if (!indented) {
            block = .none;
            if (std.mem.startsWith(u8, text, "negative:")) block = .negative;
            if (std.mem.startsWith(u8, text, "flags:")) {
                const rest = std.mem.trim(u8, text["flags:".len..], " ");
                if (rest.len == 0) {
                    block = .flags;
                } else {
                    var items = std.mem.tokenizeAny(u8, rest, "[], ");
                    while (items.next()) |flag| setFlag(&m, flag);
                }
            }
            continue;
        }
        switch (block) {
            .none => {},
            .negative => if (std.mem.startsWith(u8, text, "phase:")) {
                m.negative_parse = std.mem.eql(u8, std.mem.trim(u8, text["phase:".len..], " "), "parse");
            },
            .flags => if (std.mem.startsWith(u8, text, "- ")) setFlag(&m, std.mem.trim(u8, text[2..], " ")),
        }
    }
    return m;
}

fn setFlag(m: *Meta, flag: []const u8) void {
    if (std.mem.eql(u8, flag, "module")) m.module = true;
    if (std.mem.eql(u8, flag, "onlyStrict")) m.only_strict = true;
    if (std.mem.eql(u8, flag, "noStrict")) m.no_strict = true;
    if (std.mem.eql(u8, flag, "raw")) m.raw = true;
}

const Mode = enum { sloppy, strict, module };

/// The modes Test262's INTERPRETING.md runs a test in.
fn modes(m: Meta) []const Mode {
    if (m.module) return &.{.module};
    if (m.raw or m.no_strict) return &.{.sloppy};
    if (m.only_strict) return &.{.strict};
    return &.{ .sloppy, .strict };
}

const Counts = struct { passed: u32 = 0, total: u32 = 0 };

const Run = struct {
    a: Allocator,
    dirs: std.StringArrayHashMapUnmanaged(Counts) = .empty,
    failures: std.ArrayList(u8) = .empty,
    bytes: u64 = 0,
    parse_ns: i96 = 0,
    parses: u64 = 0,
};

/// The directory a test is counted under: its first two components below `language/`.
fn dirKey(path: []const u8) []const u8 {
    const first = std.mem.indexOfScalar(u8, path, '/') orelse return ".";
    const second = std.mem.indexOfScalarPos(u8, path, first + 1, '/') orelse return path[0..first];
    return path[0..second];
}

fn runTest(r: *Run, io: Io, scratch: Allocator, rel: []const u8, src: []const u8, list_failures: bool) !void {
    const m = readMeta(src);
    var failed: ?struct { mode: Mode, got: parse.Result } = null;
    for (modes(m)) |mode| {
        const text = if (mode == .strict) try std.mem.concat(scratch, u8, &.{ "\"use strict\";\n", src }) else src;
        const start = Io.Timestamp.now(io, .awake);
        const got = parse.parse(scratch, text, if (mode == .module) .module else .script);
        r.parse_ns += start.durationTo(Io.Timestamp.now(io, .awake)).nanoseconds;
        r.bytes += text.len;
        r.parses += 1;
        if ((got == .syntax_error) != m.negative_parse) {
            failed = .{ .mode = mode, .got = got };
            break;
        }
    }
    const key = dirKey(rel);
    const slot = try r.dirs.getOrPut(r.a, key);
    if (!slot.found_existing) {
        slot.key_ptr.* = try r.a.dupe(u8, key);
        slot.value_ptr.* = .{};
    }
    slot.value_ptr.total += 1;
    const f = failed orelse {
        slot.value_ptr.passed += 1;
        return;
    };
    if (!list_failures) return;
    const w = &r.failures;
    switch (f.got) {
        .tree => try w.print(r.a, "FAIL {s} [{t}]: parsed, expected a SyntaxError\n", .{ rel, f.mode }),
        .syntax_error => |e| try w.print(r.a, "FAIL {s} [{t}]: SyntaxError at {d}: {s}\n", .{ rel, f.mode, e.offset, e.message }),
    }
}

fn sortDirs(r: *Run) void {
    const Ctx = struct {
        keys: []const []const u8,
        pub fn lessThan(c: @This(), x: usize, y: usize) bool {
            return std.mem.lessThan(u8, c.keys[x], c.keys[y]);
        }
    };
    r.dirs.sort(Ctx{ .keys = r.dirs.keys() });
}

/// The counts `--update` wrote, one directory per line so a change reads as a diff.
fn baselineText(a: Allocator, r: *const Run) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, "{\n  \"dirs\": {\n");
    for (r.dirs.keys(), r.dirs.values(), 0..) |k, v, i| {
        const comma: []const u8 = if (i + 1 == r.dirs.count()) "" else ",";
        try out.print(a, "    \"{s}\": {{ \"passed\": {d}, \"total\": {d} }}{s}\n", .{ k, v.passed, v.total, comma });
    }
    try out.appendSlice(a, "  }\n}\n");
    return out.items;
}

const Baseline = struct { dirs: std.json.ArrayHashMap(Counts) };

/// Lines naming each directory that passes fewer tests than recorded, or holds another number of
/// them (a corpus other than the pinned one); null when nothing regressed.
fn ratchet(a: Allocator, r: *const Run, recorded: Baseline, improved: *u32) !?[]u8 {
    var out: std.ArrayList(u8) = .empty;
    var it = recorded.dirs.map.iterator();
    while (it.next()) |e| {
        const was = e.value_ptr.*;
        const now = r.dirs.get(e.key_ptr.*) orelse Counts{};
        if (now.total != was.total) {
            try out.print(a, "  {s}: {d} tests, the baseline has {d} (is the corpus at the pin?)\n", .{ e.key_ptr.*, now.total, was.total });
        } else if (now.passed < was.passed) {
            try out.print(a, "  {s}: {d} pass, the baseline has {d}\n", .{ e.key_ptr.*, now.passed, was.passed });
        } else if (now.passed > was.passed) {
            improved.* += 1;
        }
    }
    for (r.dirs.keys()) |k| {
        if (!recorded.dirs.map.contains(k)) try out.print(a, "  {s}: not in the baseline\n", .{k});
    }
    return if (out.items.len == 0) null else out.items;
}

pub fn main(init: std.process.Init) !u8 {
    const a = init.arena.allocator();
    const io = init.io;
    const args = try init.minimal.args.toSlice(a);
    var package: ?[]const u8 = null;
    var corpus: ?[]const u8 = init.environ_map.get("STATOR_TEST262");
    var filter: ?[]const u8 = null;
    var list_failures = false;
    var update = false;
    for (args[1..]) |arg| {
        if (std.mem.startsWith(u8, arg, "--package=")) {
            package = arg["--package=".len..];
        } else if (std.mem.startsWith(u8, arg, "--corpus=")) {
            corpus = arg["--corpus=".len..];
        } else if (std.mem.startsWith(u8, arg, "--filter=")) {
            filter = arg["--filter=".len..];
        } else if (std.mem.eql(u8, arg, "--failures")) {
            list_failures = true;
        } else if (std.mem.eql(u8, arg, "--update")) {
            update = true;
        } else {
            std.debug.print("test262-parse: unknown argument {s}\n", .{arg});
            return 2;
        }
    }
    const pkg = package orelse {
        std.debug.print("test262-parse: --package=<dir> is required\n", .{});
        return 2;
    };
    const root = corpus orelse try std.fs.path.join(a, &.{ pkg, "..", "tests", "test262", "corpus" });
    const language = try std.fs.path.join(a, &.{ root, "test", "language" });
    var dir = Io.Dir.cwd().openDir(io, language, .{ .iterate = true }) catch |err| {
        std.debug.print("test262-parse: {t} opening {s}; fetch the corpus with `pnpm run test262:fetch`\n", .{ err, language });
        return 2;
    };
    defer dir.close(io);

    var r: Run = .{ .a = a };
    var scratch = std.heap.ArenaAllocator.init(init.gpa);
    defer scratch.deinit();
    var walker = try dir.walk(init.gpa);
    defer walker.deinit();
    while (try walker.next(io)) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.basename, ".js")) continue;
        // Fixtures are what module tests import, not tests.
        if (std.mem.indexOf(u8, entry.basename, "_FIXTURE") != null) continue;
        if (filter) |f| if (std.mem.indexOf(u8, entry.path, f) == null) continue;
        _ = scratch.reset(.retain_capacity);
        const src = try entry.dir.readFileAlloc(io, entry.basename, scratch.allocator(), .unlimited);
        try runTest(&r, io, scratch.allocator(), entry.path, src, list_failures);
    }
    sortDirs(&r);

    var out: std.ArrayList(u8) = .empty;
    var passed: u64 = 0;
    var total: u64 = 0;
    for (r.dirs.keys(), r.dirs.values()) |k, v| {
        passed += v.passed;
        total += v.total;
        try out.print(a, "{s:<48} {d:>6} / {d:<6}\n", .{ k, v.passed, v.total });
    }
    try out.appendSlice(a, r.failures.items);
    const rate = if (total == 0) 0 else @as(f64, @floatFromInt(passed)) * 100 / @as(f64, @floatFromInt(total));
    const seconds = @as(f64, @floatFromInt(r.parse_ns)) / std.time.ns_per_s;
    const mib = @as(f64, @floatFromInt(r.bytes)) / (1024 * 1024);
    try out.print(a, "test262-parse: {d} / {d} pass ({d:.2}%)\n", .{ passed, total, rate });
    try out.print(a, "parse speed: {d} parses, {d:.2} MiB in {d:.3} s, {d:.1} MiB/s\n", .{ r.parses, mib, seconds, if (seconds == 0) 0 else mib / seconds });
    Io.File.stdout().writeStreamingAll(io, out.items) catch {};

    // A slice is not the corpus, so it neither gates nor records.
    if (filter != null) return 0;
    const baseline_path = try std.fs.path.join(a, &.{ pkg, "test262-parse.json" });
    if (update) {
        try Io.Dir.cwd().writeFile(io, .{ .sub_path = baseline_path, .data = try baselineText(a, &r) });
        std.debug.print("test262-parse: recorded {s}\n", .{baseline_path});
        return 0;
    }
    const bytes = Io.Dir.cwd().readFileAlloc(io, baseline_path, a, .unlimited) catch |err| {
        std.debug.print("test262-parse: {t} reading {s}; record one with --update\n", .{ err, baseline_path });
        return 1;
    };
    const recorded = std.json.parseFromSliceLeaky(Baseline, a, bytes, .{}) catch |err| {
        std.debug.print("test262-parse: {t} parsing {s}\n", .{ err, baseline_path });
        return 1;
    };
    var improved: u32 = 0;
    if (try ratchet(a, &r, recorded, &improved)) |lines| {
        std.debug.print("test262-parse: worse than the baseline:\n{s}", .{lines});
        return 1;
    }
    if (improved != 0) std.debug.print("test262-parse: {d} directories pass more than the baseline; record them with --update\n", .{improved});
    return 0;
}

test "metadata decides the goal, the modes and the expected outcome" {
    const negative =
        \\/*---
        \\description: x
        \\negative:
        \\  phase: parse
        \\  type: SyntaxError
        \\flags: [onlyStrict]
        \\---*/
    ;
    const m = readMeta(negative);
    try std.testing.expect(m.negative_parse and m.only_strict and !m.module);
    try std.testing.expectEqualSlices(Mode, &.{.strict}, modes(m));
    const listed =
        \\/*---
        \\negative:
        \\  phase: resolution
        \\flags:
        \\  - module
        \\---*/
    ;
    const l = readMeta(listed);
    try std.testing.expect(!l.negative_parse and l.module);
    try std.testing.expectEqualSlices(Mode, &.{ .sloppy, .strict }, modes(readMeta("/*---\ndescription: y\n---*/")));
    try std.testing.expectEqualStrings("expressions/class", dirKey("expressions/class/elements/a.js"));
    try std.testing.expectEqualStrings("asi", dirKey("asi/S7.9_A1.js"));
}
