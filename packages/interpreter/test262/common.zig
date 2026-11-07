//! What the Test262 drivers share: the metadata a test carries, the modes it runs in, the walk
//! over `test/language/`, the pass counts per directory and their ratchet against a baseline in
//! the package. A driver supplies only how one test runs in one mode.
//!
//! <driver> --package=<dir> [--corpus=<dir>] [--filter=<text>] [--failures] [--update]
//! The corpus defaults to `$STATOR_TEST262`, then to `packages/tests/test262/corpus`, where
//! `pnpm run test262:fetch` puts the pinned one.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;

pub const Phase = enum { parse, resolution, runtime };

pub const Meta = struct {
    negative: ?Phase = null,
    /// The error constructor's name a negative test expects.
    negative_type: []const u8 = "",
    includes: []const []const u8 = &.{},
    module: bool = false,
    only_strict: bool = false,
    no_strict: bool = false,
    raw: bool = false,
    async: bool = false,

    pub fn negativeParse(m: Meta) bool {
        return m.negative == .parse;
    }
};

/// The YAML between `/*---` and `---*/`, read only as far as the keys that decide how a test runs.
pub fn readMeta(a: Allocator, src: []const u8) Allocator.Error!Meta {
    var m: Meta = .{};
    const open = std.mem.indexOf(u8, src, "/*---") orelse return m;
    const close = std.mem.indexOfPos(u8, src, open, "---*/") orelse return m;
    var includes: std.ArrayList([]const u8) = .empty;
    var block: enum { none, negative, flags, includes } = .none;
    var lines = std.mem.splitScalar(u8, src[open + "/*---".len .. close], '\n');
    while (lines.next()) |line| {
        const text = std.mem.trim(u8, line, " \t\r");
        if (text.len == 0) continue;
        const indented = line[0] == ' ' or line[0] == '\t';
        if (!indented) {
            block = .none;
            if (std.mem.startsWith(u8, text, "negative:")) block = .negative;
            inline for (.{ .{ "flags:", .flags }, .{ "includes:", .includes } }) |key| {
                if (std.mem.startsWith(u8, text, key[0])) {
                    const rest = std.mem.trim(u8, text[key[0].len..], " ");
                    if (rest.len == 0) {
                        block = key[1];
                    } else {
                        var items = std.mem.tokenizeAny(u8, rest, "[], ");
                        while (items.next()) |item| try listItem(a, &m, &includes, key[1] == .includes, item);
                    }
                }
            }
            continue;
        }
        switch (block) {
            .none => {},
            .negative => {
                if (std.mem.startsWith(u8, text, "phase:")) {
                    m.negative = std.meta.stringToEnum(Phase, std.mem.trim(u8, text["phase:".len..], " "));
                } else if (std.mem.startsWith(u8, text, "type:")) {
                    m.negative_type = std.mem.trim(u8, text["type:".len..], " ");
                }
            },
            .flags, .includes => if (std.mem.startsWith(u8, text, "- ")) {
                try listItem(a, &m, &includes, block == .includes, std.mem.trim(u8, text[2..], " "));
            },
        }
    }
    m.includes = includes.items;
    return m;
}

fn listItem(a: Allocator, m: *Meta, includes: *std.ArrayList([]const u8), is_include: bool, item: []const u8) !void {
    if (is_include) return includes.append(a, item);
    if (std.mem.eql(u8, item, "module")) m.module = true;
    if (std.mem.eql(u8, item, "onlyStrict")) m.only_strict = true;
    if (std.mem.eql(u8, item, "noStrict")) m.no_strict = true;
    if (std.mem.eql(u8, item, "raw")) m.raw = true;
    if (std.mem.eql(u8, item, "async")) m.async = true;
}

pub const Mode = enum { sloppy, strict, module };

/// The modes Test262's INTERPRETING.md runs a test in.
pub fn modes(m: Meta) []const Mode {
    if (m.module) return &.{.module};
    if (m.raw or m.no_strict) return &.{.sloppy};
    if (m.only_strict) return &.{.strict};
    return &.{ .sloppy, .strict };
}

pub const strict_prefix = "\"use strict\";\n";

const Counts = struct { passed: u32 = 0, total: u32 = 0 };

const Run = struct {
    a: Allocator,
    dirs: std.StringArrayHashMapUnmanaged(Counts) = .empty,
    failures: std.ArrayList(u8) = .empty,
};

/// The directory a test is counted under: its first two components below `language/`.
fn dirKey(path: []const u8) []const u8 {
    const first = std.mem.indexOfScalar(u8, path, '/') orelse return ".";
    const second = std.mem.indexOfScalarPos(u8, path, first + 1, '/') orelse return path[0..first];
    return path[0..second];
}

const Failure = struct { mode: Mode, why: []const u8 };

fn record(r: *Run, rel: []const u8, failure: ?Failure, list_failures: bool) !void {
    const key = dirKey(rel);
    const slot = try r.dirs.getOrPut(r.a, key);
    if (!slot.found_existing) {
        slot.key_ptr.* = try r.a.dupe(u8, key);
        slot.value_ptr.* = .{};
    }
    slot.value_ptr.total += 1;
    const f = failure orelse {
        slot.value_ptr.passed += 1;
        return;
    };
    if (list_failures) try r.failures.print(r.a, "FAIL {s} [{t}]: {s}\n", .{ rel, f.mode, f.why });
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

/// Runs every test under `test/language/` through `driver`, prints the counts and ratchets them
/// against `<name>.json` in the package. `driver` has:
///   fn setup(driver, a: Allocator, io: Io, corpus: []const u8) !void
///   fn runTest(driver, scratch: Allocator, io: Io, meta: Meta, mode: Mode, src: []const u8) !?[]const u8
///     — null for a pass, else why it failed
///   fn summary(driver, a: Allocator, out: *std.ArrayList(u8)) !void
pub fn main(init: std.process.Init, comptime name: []const u8, driver: anytype) !u8 {
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
            std.debug.print(name ++ ": unknown argument {s}\n", .{arg});
            return 2;
        }
    }
    const pkg = package orelse {
        std.debug.print(name ++ ": --package=<dir> is required\n", .{});
        return 2;
    };
    const root = corpus orelse try std.fs.path.join(a, &.{ pkg, "..", "tests", "test262", "corpus" });
    const language = try std.fs.path.join(a, &.{ root, "test", "language" });
    var dir = Io.Dir.cwd().openDir(io, language, .{ .iterate = true }) catch |err| {
        std.debug.print(name ++ ": {t} opening {s}; fetch the corpus with `pnpm run test262:fetch`\n", .{ err, language });
        return 2;
    };
    defer dir.close(io);
    try driver.setup(a, io, root);

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
        const sa = scratch.allocator();
        const src = try entry.dir.readFileAlloc(io, entry.basename, sa, .unlimited);
        const meta = try readMeta(sa, src);
        const failure: ?Failure = for (modes(meta)) |mode| {
            if (try driver.runTest(sa, io, meta, mode, src)) |why| break .{ .mode = mode, .why = why };
        } else null;
        try record(&r, entry.path, failure, list_failures);
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
    try out.print(a, name ++ ": {d} / {d} pass ({d:.2}%)\n", .{ passed, total, rate });
    try driver.summary(a, &out);
    Io.File.stdout().writeStreamingAll(io, out.items) catch {};

    // A slice is not the corpus, so it neither gates nor records.
    if (filter != null) return 0;
    const baseline_path = try std.fs.path.join(a, &.{ pkg, name ++ ".json" });
    if (update) {
        try Io.Dir.cwd().writeFile(io, .{ .sub_path = baseline_path, .data = try baselineText(a, &r) });
        std.debug.print(name ++ ": recorded {s}\n", .{baseline_path});
        return 0;
    }
    const bytes = Io.Dir.cwd().readFileAlloc(io, baseline_path, a, .unlimited) catch |err| {
        std.debug.print(name ++ ": {t} reading {s}; record one with --update\n", .{ err, baseline_path });
        return 1;
    };
    const recorded = std.json.parseFromSliceLeaky(Baseline, a, bytes, .{}) catch |err| {
        std.debug.print(name ++ ": {t} parsing {s}\n", .{ err, baseline_path });
        return 1;
    };
    var improved: u32 = 0;
    if (try ratchet(a, &r, recorded, &improved)) |lines| {
        std.debug.print(name ++ ": worse than the baseline:\n{s}", .{lines});
        return 1;
    }
    if (improved != 0) std.debug.print(name ++ ": {d} directories pass more than the baseline; record them with --update\n", .{improved});
    return 0;
}

test "metadata decides the goal, the modes and the expected outcome" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const negative =
        \\/*---
        \\description: x
        \\negative:
        \\  phase: parse
        \\  type: SyntaxError
        \\flags: [onlyStrict]
        \\includes: [compareArray.js]
        \\---*/
    ;
    const m = try readMeta(a, negative);
    try std.testing.expect(m.negativeParse() and m.only_strict and !m.module);
    try std.testing.expectEqualStrings("SyntaxError", m.negative_type);
    try std.testing.expectEqual(1, m.includes.len);
    try std.testing.expectEqualSlices(Mode, &.{.strict}, modes(m));
    const listed =
        \\/*---
        \\negative:
        \\  phase: resolution
        \\flags:
        \\  - module
        \\includes:
        \\  - a.js
        \\  - b.js
        \\---*/
    ;
    const l = try readMeta(a, listed);
    try std.testing.expect(!l.negativeParse() and l.module and l.negative == .resolution);
    try std.testing.expectEqual(2, l.includes.len);
    try std.testing.expectEqualSlices(Mode, &.{ .sloppy, .strict }, modes(try readMeta(a, "/*---\ndescription: y\n---*/")));
    try std.testing.expectEqualStrings("expressions/class", dirKey("expressions/class/elements/a.js"));
    try std.testing.expectEqualStrings("asi", dirKey("asi/S7.9_A1.js"));
}
