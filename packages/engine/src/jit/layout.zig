//! The backend solves liveness backwards in block order. Reverse postorder keeps forward
//! dependencies in one sweep instead of making the solver revisit allocation-order diamonds.
//! Keep cyclic graphs in their original layout: ordering loops also changes generated code
//! locality and register pressure, and regressed the warmed object kernel (plan/T74).
const std = @import("std");
const ir = @import("pyrlyn_jit").ir;

fn targets(op: *ir.Op, buf: *[2]*u32) []*u32 {
    switch (op.*) {
        .br => |*b| buf[0] = b,
        .bra => |*b| buf[0] = &b.target,
        inline .cbr, .cbra => |*b| {
            buf.* = .{ &b.then, &b.@"else" };
            return buf;
        },
        .ret => return buf[0..0],
        else => unreachable,
    }
    return buf[0..1];
}

pub fn orderAcyclic(f: *ir.Func) !void {
    try f.verify();
    const blocks = f.blocks.items;
    const n = blocks.len;
    const a = f.alloc();
    const State = enum { unseen, active, done };
    const seen = try a.alloc(State, n);
    @memset(seen, .unseen);
    const order = try a.alloc(u32, n);
    const Frame = struct { block: u32, next: usize = 0 };
    const stack = try a.alloc(Frame, n);
    stack[0] = .{ .block = 0 };
    seen[0] = .active;
    var depth: usize = 1;
    var used: usize = 0;
    while (depth != 0) {
        const frame = &stack[depth - 1];
        const ops = blocks[frame.block].ops.items;
        var buf: [2]*u32 = undefined;
        const edges = targets(&ops[ops.len - 1], &buf);
        if (frame.next < edges.len) {
            const child = edges[frame.next].*;
            frame.next += 1;
            if (seen[child] == .active) return;
            if (seen[child] == .unseen) {
                seen[child] = .active;
                stack[depth] = .{ .block = child };
                depth += 1;
            }
        } else {
            order[used] = frame.block;
            seen[frame.block] = .done;
            used += 1;
            depth -= 1;
        }
    }
    std.mem.reverse(u32, order[0..used]);
    // Keep unreachable blocks (including the unused exception exit) valid without making
    // their arbitrary edges choose the real function entry or its reachable layout.
    for (seen, 0..) |visited, i| if (visited == .unseen) {
        order[used] = @intCast(i);
        used += 1;
    };
    const mapping = try a.alloc(u32, n);
    for (order, 0..) |old, new| mapping[old] = @intCast(new);
    const reordered = try a.alloc(ir.Block, n);
    for (order, reordered) |old, *b| {
        b.* = blocks[old];
        var buf: [2]*u32 = undefined;
        for (targets(&b.ops.items[b.ops.items.len - 1], &buf)) |target| target.* = mapping[target.*];
    }
    @memcpy(blocks, reordered);
}

test "layout preserves diamond edges, entry, and unreachable blocks" {
    var f = try ir.parse(std.testing.allocator,
        \\func f 1
        \\entry:
        \\  cbr eq v0 v0 yes no
        \\join:
        \\  ret v0
        \\yes:
        \\  br join
        \\no:
        \\  br join
        \\unused:
        \\  ret v0
    );
    defer f.deinit();
    try orderAcyclic(&f);
    try f.verify();
    try std.testing.expectEqualStrings("entry", f.blocks.items[0].name);
    try std.testing.expectEqualStrings("join", f.blocks.items[3].name);
    try std.testing.expectEqualStrings("unused", f.blocks.items[4].name);
    try std.testing.expectEqual(@as(u32, 3), f.blocks.items[1].ops.items[0].br);
    try std.testing.expectEqual(@as(u32, 3), f.blocks.items[2].ops.items[0].br);
    const branch = f.blocks.items[0].ops.items[0].cbr;
    try std.testing.expectEqualStrings("yes", f.blocks.items[branch.then].name);
    try std.testing.expectEqualStrings("no", f.blocks.items[branch.@"else"].name);
}

test "layout preserves the original block order when a backedge exists" {
    var f = try ir.parse(std.testing.allocator,
        \\func f 1
        \\entry:
        \\  br loop
        \\exit:
        \\  ret v0
        \\loop:
        \\  cbr eq v0 v0 loop exit
    );
    defer f.deinit();
    try orderAcyclic(&f);
    try f.verify();
    try std.testing.expectEqualStrings("loop", f.blocks.items[2].name);
    const branch = f.blocks.items[2].ops.items[0].cbr;
    try std.testing.expectEqual(@as(u32, 2), branch.then);
    try std.testing.expectEqual(@as(u32, 1), branch.@"else");
}

test "layout keeps block arguments on their original edges" {
    var f = try ir.parse(std.testing.allocator,
        \\func f 1
        \\entry:
        \\  br body v0
        \\exit(v2):
        \\  ret v2
        \\body(v1):
        \\  cbr eq v1 v0 exit:v1 exit:v0
    );
    defer f.deinit();
    try orderAcyclic(&f);
    try f.verifySsa(std.testing.allocator);
    const start = f.blocks.items[0].ops.items[0].bra;
    try std.testing.expectEqual(@as(u32, 1), start.target);
    try std.testing.expectEqualSlices(ir.VReg, &.{0}, start.args);
    const branch = f.blocks.items[1].ops.items[0].cbra;
    try std.testing.expectEqual(@as(u32, 2), branch.then);
    try std.testing.expectEqual(@as(u32, 2), branch.@"else");
    try std.testing.expectEqualSlices(ir.VReg, &.{1}, branch.then_args);
    try std.testing.expectEqualSlices(ir.VReg, &.{0}, branch.else_args);
}
