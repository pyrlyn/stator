//! Collected memory as a Zig allocator. A list that holds `jsrt_value`s or `Proto` pointers while
//! the compiler builds a function lives here: the collector's masking scan traces the block, and
//! the list header on the native stack keeps the block itself alive (docs/VALUE.md §4.12).

const std = @import("std");
const c = @import("jsrt");
const Allocator = std.mem.Allocator;

pub const allocator: Allocator = .{ .ptr = undefined, .vtable = &.{
    .alloc = alloc,
    .resize = Allocator.noResize,
    .remap = Allocator.noRemap,
    .free = Allocator.noFree,
} };

fn alloc(_: *anyopaque, len: usize, alignment: std.mem.Alignment, _: usize) ?[*]u8 {
    // The collector aligns every block to at least 16 bytes.
    std.debug.assert(alignment.toByteUnits() <= 16);
    return @ptrCast(c.jsrt_gc_alloc(len, "interpreter"));
}

pub fn dupe(comptime T: type, items: []const T) []T {
    return allocator.dupe(T, items) catch unreachable;
}
