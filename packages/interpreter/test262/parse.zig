//! Test262's `test/language/` through the interpreter's parse entry (plan T14.1). A test whose
//! metadata says `negative: phase: parse` must be a `SyntaxError`; every other test must parse,
//! in each mode its flags ask for: the module goal for `module`, the source as it is for `raw` and
//! `noStrict`, with `"use strict";` before it for `onlyStrict`, and both otherwise. Pass counts per
//! directory are ratcheted against `test262-parse.json` in the package; `--update` records them.
//! Arguments and corpus: `common.zig`.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const parse = @import("stator_interp").parse;
const common = @import("common.zig");

const Driver = struct {
    bytes: u64 = 0,
    parse_ns: i96 = 0,
    parses: u64 = 0,

    pub fn setup(_: *Driver, _: Allocator, _: Io, _: []const u8) !void {}

    pub fn runTest(d: *Driver, scratch: Allocator, io: Io, m: common.Meta, mode: common.Mode, src: []const u8) !?[]const u8 {
        const text = if (mode == .strict) try std.mem.concat(scratch, u8, &.{ common.strict_prefix, src }) else src;
        const start = Io.Timestamp.now(io, .awake);
        const got = parse.parse(scratch, text, if (mode == .module) .module else .script);
        d.parse_ns += start.durationTo(Io.Timestamp.now(io, .awake)).nanoseconds;
        d.bytes += text.len;
        d.parses += 1;
        if ((got == .syntax_error) == m.negativeParse()) return null;
        return switch (got) {
            .tree => "parsed, expected a SyntaxError",
            .syntax_error => |e| try std.fmt.allocPrint(scratch, "SyntaxError at {d}: {s}", .{ e.offset, e.message }),
        };
    }

    pub fn summary(d: *Driver, a: Allocator, out: *std.ArrayList(u8)) !void {
        const seconds = @as(f64, @floatFromInt(d.parse_ns)) / std.time.ns_per_s;
        const mib = @as(f64, @floatFromInt(d.bytes)) / (1024 * 1024);
        try out.print(a, "parse speed: {d} parses, {d:.2} MiB in {d:.3} s, {d:.1} MiB/s\n", .{ d.parses, mib, seconds, if (seconds == 0) 0 else mib / seconds });
    }
};

pub fn main(init: std.process.Init) !u8 {
    var d: Driver = .{};
    return common.main(init, "test262-parse", &d);
}

test {
    _ = common;
}
