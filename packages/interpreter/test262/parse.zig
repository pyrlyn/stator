//! Test262's `test/language/` through the interpreter's parse entry (plan T14.1). A test whose
//! metadata says `negative: phase: parse` must be a `SyntaxError`; every other test must parse,
//! in each mode its flags ask for: the module goal for `module`, the source as it is for `raw` and
//! `noStrict`, with `"use strict";` before it for `onlyStrict`, and both otherwise. Pass counts per
//! directory are ratcheted against `test262-parse.json` in the package; `--update` records them.
//! The command line is common.zig's.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const parse = @import("stator_interp").parse;
const common = @import("common.zig");
const Mode = common.Mode;

const Speed = struct {
    bytes: u64 = 0,
    parse_ns: i96 = 0,
    parses: u64 = 0,
};

fn runTest(t: *common.Tally, speed: *Speed, io: Io, scratch: Allocator, rel: []const u8, src: []const u8, list_failures: bool) !void {
    const m = common.readMeta(src);
    var failed: ?struct { mode: Mode, got: parse.Result } = null;
    for (common.modes(m)) |mode| {
        const text = if (mode == .strict) try std.mem.concat(scratch, u8, &.{ "\"use strict\";\n", src }) else src;
        const start = Io.Timestamp.now(io, .awake);
        const got = parse.parse(scratch, text, if (mode == .module) .module else .script);
        speed.parse_ns += start.durationTo(Io.Timestamp.now(io, .awake)).nanoseconds;
        speed.bytes += text.len;
        speed.parses += 1;
        if ((got == .syntax_error) != m.negativeParse()) {
            failed = .{ .mode = mode, .got = got };
            break;
        }
    }
    try t.record(rel, failed == null);
    const f = failed orelse return;
    if (!list_failures) return;
    switch (f.got) {
        .tree => try t.failures.print(t.a, "FAIL {s} [{t}]: parsed, expected a SyntaxError\n", .{ rel, f.mode }),
        .syntax_error => |e| try t.failures.print(t.a, "FAIL {s} [{t}]: SyntaxError at {d}: {s}\n", .{ rel, f.mode, e.offset, e.message }),
    }
}

pub fn main(init: std.process.Init) !u8 {
    const a = init.arena.allocator();
    const io = init.io;
    const o = try common.parseArgs(init, "test262-parse") orelse return 2;
    var corpus = try common.Corpus.open(o, init.gpa, io) orelse return 2;
    defer corpus.close(io);

    var t: common.Tally = .{ .a = a };
    var speed: Speed = .{};
    while (try corpus.next(io)) |e| try runTest(&t, &speed, io, corpus.scratch.allocator(), e.path, e.src, o.failures);

    const seconds = @as(f64, @floatFromInt(speed.parse_ns)) / std.time.ns_per_s;
    const mib = @as(f64, @floatFromInt(speed.bytes)) / (1024 * 1024);
    const summary = try std.fmt.allocPrint(a, "parse speed: {d} parses, {d:.2} MiB in {d:.3} s, {d:.1} MiB/s\n", .{ speed.parses, mib, seconds, if (seconds == 0) 0 else mib / seconds });
    return common.finish(a, io, o, &t, "test262-parse.json", summary);
}

test {
    _ = common;
}
