//! Which roadmap phases are finished, so a `not-yet` can be checked against them. `done.md` is the
//! authority and this its machine-readable projection (`packages/compiler/src/support/phases.ts`).
//! A not-yet with no phase to name omits it rather than inventing a number.

pub const completed_phases = [_]u32{ 0, 1, 2, 3, 4, 7, 9 };

pub fn isCompleted(phase: u32) bool {
    for (completed_phases) |p| if (p == phase) return true;
    return false;
}

test "open phases are not completed" {
    const std = @import("std");
    try std.testing.expect(isCompleted(4));
    try std.testing.expect(!isCompleted(5));
}
