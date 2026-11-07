//! What the interpreter's Test262 drivers share: the metadata a test carries, the modes it runs
//! in, the corpus walk, and the per-directory pass counts ratcheted against a JSON baseline in
//! the package.
//!
//! <driver> --package=<dir> [--corpus=<dir>] [--filter=<text>] [--failures] [--update]
//! The corpus defaults to `$STATOR_TEST262`, then to `packages/tests/test262/corpus`, where
//! `pnpm run test262:fetch` puts the pinned one.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;

pub const max_includes = 16;

pub const Meta = struct {
    /// `negative: phase:` — parse, resolution or runtime.
    negative_phase: []const u8 = "",
    /// `negative: type:` — the error constructor's name.
    negative_type: []const u8 = "",
    module: bool = false,
    only_strict: bool = false,
    no_strict: bool = false,
    raw: bool = false,
    is_async: bool = false,
    /// Harness files the test needs besides `assert.js` and `sta.js`.
    include_buf: [max_includes][]const u8 = undefined,
    include_len: usize = 0,

    pub fn negativeParse(m: *const Meta) bool {
        return std.mem.eql(u8, m.negative_phase, "parse");
    }

    pub fn includes(m: *const Meta) []const []const u8 {
        return m.include_buf[0..m.include_len];
    }

    fn include(m: *Meta, name: []const u8) void {
        if (m.include_len == max_includes) return;
        m.include_buf[m.include_len] = name;
        m.include_len += 1;
    }
};

/// The YAML between `/*---` and `---*/`, read only as far as the keys that decide a run.
pub fn readMeta(src: []const u8) Meta {
    var m: Meta = .{};
    const open = std.mem.indexOf(u8, src, "/*---") orelse return m;
    const close = std.mem.indexOfPos(u8, src, open, "---*/") orelse return m;
    var block: enum { none, negative, flags, includes } = .none;
    var lines = std.mem.splitScalar(u8, src[open + "/*---".len .. close], '\n');
    while (lines.next()) |line| {
        const text = std.mem.trim(u8, line, " \t\r");
        if (text.len == 0) continue;
        const indented = line[0] == ' ' or line[0] == '\t';
        if (!indented) {
            block = .none;
            if (std.mem.startsWith(u8, text, "negative:")) block = .negative;
            if (listKey(text, "flags:")) |rest| {
                if (rest.len == 0) block = .flags else eachItem(&m, rest, setFlag);
            }
            if (listKey(text, "includes:")) |rest| {
                if (rest.len == 0) block = .includes else eachItem(&m, rest, Meta.include);
            }
            continue;
        }
        switch (block) {
            .none => {},
            .negative => {
                if (std.mem.startsWith(u8, text, "phase:")) m.negative_phase = std.mem.trim(u8, text["phase:".len..], " ");
                if (std.mem.startsWith(u8, text, "type:")) m.negative_type = std.mem.trim(u8, text["type:".len..], " ");
            },
            .flags => if (std.mem.startsWith(u8, text, "- ")) setFlag(&m, std.mem.trim(u8, text[2..], " ")),
            .includes => if (std.mem.startsWith(u8, text, "- ")) m.include(std.mem.trim(u8, text[2..], " ")),
        }
    }
    return m;
}

fn listKey(text: []const u8, key: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, text, key)) return null;
    return std.mem.trim(u8, text[key.len..], " ");
}

fn eachItem(m: *Meta, inline_list: []const u8, comptime f: fn (*Meta, []const u8) void) void {
    var items = std.mem.tokenizeAny(u8, inline_list, "[], ");
    while (items.next()) |item| f(m, item);
}

fn setFlag(m: *Meta, flag: []const u8) void {
    if (std.mem.eql(u8, flag, "module")) m.module = true;
    if (std.mem.eql(u8, flag, "onlyStrict")) m.only_strict = true;
    if (std.mem.eql(u8, flag, "noStrict")) m.no_strict = true;
    if (std.mem.eql(u8, flag, "raw")) m.raw = true;
    if (std.mem.eql(u8, flag, "async")) m.is_async = true;
}

pub const Mode = enum { sloppy, strict, module };

/// The modes Test262's INTERPRETING.md runs a test in.
pub fn modes(m: Meta) []const Mode {
    if (m.module) return &.{.module};
    if (m.raw or m.no_strict) return &.{.sloppy};
    if (m.only_strict) return &.{.strict};
    return &.{ .sloppy, .strict };
}

pub const Counts = struct { passed: u32 = 0, total: u32 = 0 };

/// Pass counts per directory, and the failures `--failures` lists.
pub const Tally = struct {
    a: Allocator,
    dirs: std.StringArrayHashMapUnmanaged(Counts) = .empty,
    failures: std.ArrayList(u8) = .empty,

    pub fn record(t: *Tally, rel: []const u8, passed: bool) !void {
        const key = dirKey(rel);
        const slot = try t.dirs.getOrPut(t.a, key);
        if (!slot.found_existing) {
            slot.key_ptr.* = try t.a.dupe(u8, key);
            slot.value_ptr.* = .{};
        }
        slot.value_ptr.total += 1;
        if (passed) slot.value_ptr.passed += 1;
    }

    fn sort(t: *Tally) void {
        const Ctx = struct {
            keys: []const []const u8,
            pub fn lessThan(c: @This(), x: usize, y: usize) bool {
                return std.mem.lessThan(u8, c.keys[x], c.keys[y]);
            }
        };
        t.dirs.sort(Ctx{ .keys = t.dirs.keys() });
    }
};

/// The directory a test is counted under: its first two components below `language/`.
pub fn dirKey(path: []const u8) []const u8 {
    const first = std.mem.indexOfScalar(u8, path, '/') orelse return ".";
    const second = std.mem.indexOfScalarPos(u8, path, first + 1, '/') orelse return path[0..first];
    return path[0..second];
}

pub const Options = struct {
    tool: []const u8,
    package: []const u8,
    corpus: []const u8,
    filter: ?[]const u8 = null,
    failures: bool = false,
    update: bool = false,
};

/// The command line, or null after printing why it is wrong.
pub fn parseArgs(init: std.process.Init, tool: []const u8) !?Options {
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    var package: ?[]const u8 = null;
    var corpus: ?[]const u8 = init.environ_map.get("STATOR_TEST262");
    var o: Options = .{ .tool = tool, .package = "", .corpus = "" };
    for (args[1..]) |arg| {
        if (std.mem.startsWith(u8, arg, "--package=")) {
            package = arg["--package=".len..];
        } else if (std.mem.startsWith(u8, arg, "--corpus=")) {
            corpus = arg["--corpus=".len..];
        } else if (std.mem.startsWith(u8, arg, "--filter=")) {
            o.filter = arg["--filter=".len..];
        } else if (std.mem.eql(u8, arg, "--failures")) {
            o.failures = true;
        } else if (std.mem.eql(u8, arg, "--update")) {
            o.update = true;
        } else {
            std.debug.print("{s}: unknown argument {s}\n", .{ tool, arg });
            return null;
        }
    }
    o.package = package orelse {
        std.debug.print("{s}: --package=<dir> is required\n", .{tool});
        return null;
    };
    o.corpus = corpus orelse try std.fs.path.join(a, &.{ o.package, "..", "tests", "test262", "corpus" });
    return o;
}

/// The tests under `test/language/`, fixtures and the filter's misses left out.
pub const Corpus = struct {
    dir: Io.Dir,
    walker: Io.Dir.Walker,
    scratch: std.heap.ArenaAllocator,
    filter: ?[]const u8,

    pub const Test = struct { path: []const u8, src: []const u8 };

    pub fn open(o: Options, gpa: Allocator, io: Io) !?Corpus {
        var buf: [std.fs.max_path_bytes]u8 = undefined;
        const language = try std.fmt.bufPrint(&buf, "{s}/test/language", .{o.corpus});
        var dir = Io.Dir.cwd().openDir(io, language, .{ .iterate = true }) catch |err| {
            std.debug.print("{s}: {t} opening {s}; fetch the corpus with `pnpm run test262:fetch`\n", .{ o.tool, err, language });
            return null;
        };
        errdefer dir.close(io);
        return .{ .dir = dir, .walker = try dir.walk(gpa), .scratch = .init(gpa), .filter = o.filter };
    }

    /// The next test, its path and source valid until the next call.
    pub fn next(c: *Corpus, io: Io) !?Test {
        while (try c.walker.next(io)) |entry| {
            if (entry.kind != .file or !std.mem.endsWith(u8, entry.basename, ".js")) continue;
            // Fixtures are what module tests import, not tests.
            if (std.mem.indexOf(u8, entry.basename, "_FIXTURE") != null) continue;
            if (c.filter) |f| if (std.mem.indexOf(u8, entry.path, f) == null) continue;
            _ = c.scratch.reset(.retain_capacity);
            const src = try entry.dir.readFileAlloc(io, entry.basename, c.scratch.allocator(), .unlimited);
            return .{ .path = entry.path, .src = src };
        }
        return null;
    }

    pub fn close(c: *Corpus, io: Io) void {
        c.walker.deinit();
        c.scratch.deinit();
        c.dir.close(io);
    }
};

/// The counts `--update` wrote, one directory per line so a change reads as a diff.
fn baselineText(a: Allocator, t: *const Tally) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, "{\n  \"dirs\": {\n");
    for (t.dirs.keys(), t.dirs.values(), 0..) |k, v, i| {
        const comma: []const u8 = if (i + 1 == t.dirs.count()) "" else ",";
        try out.print(a, "    \"{s}\": {{ \"passed\": {d}, \"total\": {d} }}{s}\n", .{ k, v.passed, v.total, comma });
    }
    try out.appendSlice(a, "  }\n}\n");
    return out.items;
}

const Baseline = struct { dirs: std.json.ArrayHashMap(Counts) };

/// Lines naming each directory that passes fewer tests than recorded, or holds another number of
/// them (a corpus other than the pinned one); null when nothing regressed.
fn ratchet(a: Allocator, t: *const Tally, recorded: Baseline, improved: *u32) !?[]u8 {
    var out: std.ArrayList(u8) = .empty;
    var it = recorded.dirs.map.iterator();
    while (it.next()) |e| {
        const was = e.value_ptr.*;
        const now = t.dirs.get(e.key_ptr.*) orelse Counts{};
        if (now.total != was.total) {
            try out.print(a, "  {s}: {d} tests, the baseline has {d} (is the corpus at the pin?)\n", .{ e.key_ptr.*, now.total, was.total });
        } else if (now.passed < was.passed) {
            try out.print(a, "  {s}: {d} pass, the baseline has {d}\n", .{ e.key_ptr.*, now.passed, was.passed });
        } else if (now.passed > was.passed) {
            improved.* += 1;
        }
    }
    for (t.dirs.keys()) |k| {
        if (!recorded.dirs.map.contains(k)) try out.print(a, "  {s}: not in the baseline\n", .{k});
    }
    return if (out.items.len == 0) null else out.items;
}

/// Prints the per-directory table, the failures and `summary`, then records the baseline
/// (`--update`) or gates on it. Answers the exit code.
pub fn finish(a: Allocator, io: Io, o: Options, t: *Tally, baseline_name: []const u8, summary: []const u8) !u8 {
    t.sort();
    var out: std.ArrayList(u8) = .empty;
    var passed: u64 = 0;
    var total: u64 = 0;
    for (t.dirs.keys(), t.dirs.values()) |k, v| {
        passed += v.passed;
        total += v.total;
        try out.print(a, "{s:<48} {d:>6} / {d:<6}\n", .{ k, v.passed, v.total });
    }
    try out.appendSlice(a, t.failures.items);
    const rate = if (total == 0) 0 else @as(f64, @floatFromInt(passed)) * 100 / @as(f64, @floatFromInt(total));
    try out.print(a, "{s}: {d} / {d} pass ({d:.2}%)\n{s}", .{ o.tool, passed, total, rate, summary });
    Io.File.stdout().writeStreamingAll(io, out.items) catch {};

    // A slice is not the corpus, so it neither gates nor records.
    if (o.filter != null) return 0;
    const baseline_path = try std.fs.path.join(a, &.{ o.package, baseline_name });
    if (o.update) {
        try Io.Dir.cwd().writeFile(io, .{ .sub_path = baseline_path, .data = try baselineText(a, t) });
        std.debug.print("{s}: recorded {s}\n", .{ o.tool, baseline_path });
        return 0;
    }
    const bytes = Io.Dir.cwd().readFileAlloc(io, baseline_path, a, .unlimited) catch |err| {
        std.debug.print("{s}: {t} reading {s}; record one with --update\n", .{ o.tool, err, baseline_path });
        return 1;
    };
    const recorded = std.json.parseFromSliceLeaky(Baseline, a, bytes, .{}) catch |err| {
        std.debug.print("{s}: {t} parsing {s}\n", .{ o.tool, err, baseline_path });
        return 1;
    };
    var improved: u32 = 0;
    if (try ratchet(a, t, recorded, &improved)) |lines| {
        std.debug.print("{s}: worse than the baseline:\n{s}", .{ o.tool, lines });
        return 1;
    }
    if (improved != 0) std.debug.print("{s}: {d} directories pass more than the baseline; record them with --update\n", .{ o.tool, improved });
    return 0;
}

test "metadata decides the goal, the modes, the includes and the expected outcome" {
    const negative =
        \\/*---
        \\description: x
        \\negative:
        \\  phase: parse
        \\  type: SyntaxError
        \\flags: [onlyStrict]
        \\includes: [compareArray.js, propertyHelper.js]
        \\---*/
    ;
    const m = readMeta(negative);
    try std.testing.expect(m.negativeParse() and m.only_strict and !m.module);
    try std.testing.expectEqualStrings("SyntaxError", m.negative_type);
    try std.testing.expectEqual(@as(usize, 2), m.includes().len);
    try std.testing.expectEqualStrings("propertyHelper.js", m.includes()[1]);
    try std.testing.expectEqualSlices(Mode, &.{.strict}, modes(m));
    const listed =
        \\/*---
        \\negative:
        \\  phase: resolution
        \\flags:
        \\  - module
        \\  - async
        \\includes:
        \\  - asyncHelpers.js
        \\---*/
    ;
    const l = readMeta(listed);
    try std.testing.expect(!l.negativeParse() and l.module and l.is_async);
    try std.testing.expectEqualStrings("asyncHelpers.js", l.includes()[0]);
    try std.testing.expectEqualSlices(Mode, &.{ .sloppy, .strict }, modes(readMeta("/*---\ndescription: y\n---*/")));
    try std.testing.expectEqualStrings("expressions/class", dirKey("expressions/class/elements/a.js"));
    try std.testing.expectEqualStrings("asi", dirKey("asi/S7.9_A1.js"));
}
