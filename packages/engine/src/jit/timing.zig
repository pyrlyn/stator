//! Compilation stage timing, enabled only by the existing JIT trace switch.
const std = @import("std");
extern "c" fn rt_nanos() i64;

pub const Timing = struct {
    enabled: bool,
    last: i64,
    stages: [4]i64 = @splat(0),

    pub fn start(enabled: bool) Timing {
        return .{ .enabled = enabled, .last = if (enabled) rt_nanos() else 0 };
    }

    pub fn mark(t: *Timing, comptime stage: usize) void {
        if (!t.enabled) return;
        const now = rt_nanos();
        t.stages[stage] = now - t.last;
        t.last = now;
    }

    pub fn report(t: Timing, name: [:0]const u8, success: bool) void {
        if (!t.enabled) return;
        std.debug.print("jit-time: {s} {s} {d} {d} {d} {d}\n", .{
            name,        if (success) "compiled" else "rejected",
            t.stages[0], t.stages[1],
            t.stages[2], t.stages[3],
        });
    }
};
