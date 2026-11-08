//! Which templates the baseline JIT takes, and the operand-stack depth before every instruction
//! it will lower (docs/ENGINE.md §3). A template is taken when every reachable instruction is one
//! `lower.zig` handles and every join point is reached at one depth; anything else stays in the
//! interpreter, which runs it with the same result.

const std = @import("std");
const bc = @import("../bytecode.zig");
const Op = bc.Op;
const Template = bc.Template;
const parse = @import("../parse.zig");
const compile = @import("../compile.zig");

const op_count = @typeInfo(Op).@"enum".field_names.len;

pub const Insn = struct {
    pc: u32,
    op: Op,
    /// Operands on the stack before the instruction runs.
    depth: u32,
    /// Decoded inline operands; their meaning is the opcode's (bytecode.zig).
    a: u32 = 0,
    b: u32 = 0,
    c: u32 = 0,
    d: u32 = 0,
    /// Where the next instruction starts.
    next: u32,
    /// Another instruction jumps here, or a conditional jump falls through here: a block starts.
    leader: bool = false,
};

pub const Plan = struct {
    /// The reachable instructions in code order.
    insns: []Insn,

    pub fn deinit(p: Plan, gpa: std.mem.Allocator) void {
        gpa.free(p.insns);
    }
};

pub const Reject = union(enum) {
    /// Handlers, generators and async bodies need the interpreter's unwinding and suspension.
    shape: []const u8,
    op: Op,
    /// Two paths reach one instruction at different depths.
    depth: u32,
};

pub const Result = union(enum) { plan: Plan, reject: Reject };

pub fn analyze(gpa: std.mem.Allocator, t: *const Template) error{OutOfMemory}!Result {
    if (t.handlers.len != 0) return .{ .reject = .{ .shape = "exception handlers" } };
    if (t.generator) return .{ .reject = .{ .shape = "generator" } };
    if (t.is_async) return .{ .reject = .{ .shape = "async" } };

    const code = t.code;
    const none = std.math.maxInt(u32);
    const depth_at = try gpa.alloc(u32, code.len + 1);
    defer gpa.free(depth_at);
    @memset(depth_at, none);
    const leader = try gpa.alloc(bool, code.len + 1);
    defer gpa.free(leader);
    @memset(leader, false);

    var found: std.ArrayList(Insn) = .empty;
    // Every reject returns with `found` live; toOwnedSlice leaves it empty for the plan.
    defer found.deinit(gpa);
    var work: std.ArrayList(u32) = .empty;
    defer work.deinit(gpa);

    depth_at[0] = 0;
    try work.append(gpa, 0);
    while (work.pop()) |start| {
        var pc = start;
        while (true) {
            if (pc >= code.len) return .{ .reject = .{ .shape = "falls off the end" } };
            const d = depth_at[pc];
            const insn = decode(code, pc, d) orelse return .{ .reject = if (code[pc] < op_count) .{ .op = @fromBackingInt(code[pc]) } else .{ .shape = "bad opcode" } };
            const fx = effect(insn);
            if (d < fx.pops or d - fx.pops + fx.pushes > t.max_stack) return .{ .reject = .{ .shape = "stack bounds" } };
            try found.append(gpa, insn);
            const after = d - fx.pops + fx.pushes;
            switch (insn.op) {
                .ret, .ret_ctor, .ret_this, .throw => break,
                .jump => {
                    leader[insn.a] = true;
                    if (!try reach(gpa, &work, depth_at, insn.a, after)) return .{ .reject = .{ .depth = insn.a } };
                    break;
                },
                .jump_if_false, .jump_if_true, .jump_if_nullish, .jump_if_not_undef => {
                    leader[insn.a] = true;
                    leader[insn.next] = true;
                    if (!try reach(gpa, &work, depth_at, insn.a, after)) return .{ .reject = .{ .depth = insn.a } };
                    if (!try reach(gpa, &work, depth_at, insn.next, after)) return .{ .reject = .{ .depth = insn.next } };
                    break;
                },
                else => {
                    // A straight-line successor already decoded was reached by a jump: its depth
                    // must agree, and the walk stops there.
                    if (depth_at[insn.next] != none) {
                        if (depth_at[insn.next] != after) return .{ .reject = .{ .depth = insn.next } };
                        leader[insn.next] = true;
                        break;
                    }
                    depth_at[insn.next] = after;
                    pc = insn.next;
                },
            }
        }
    }

    const insns = try found.toOwnedSlice(gpa);
    std.mem.sort(Insn, insns, {}, struct {
        fn lt(_: void, x: Insn, y: Insn) bool {
            return x.pc < y.pc;
        }
    }.lt);
    for (insns) |*i| i.leader = leader[i.pc];
    return .{ .plan = .{ .insns = insns } };
}

/// Queues `pc` at `depth` the first time; false when it was reached before at another depth.
fn reach(gpa: std.mem.Allocator, work: *std.ArrayList(u32), depth_at: []u32, pc: u32, depth: u32) error{OutOfMemory}!bool {
    if (pc >= depth_at.len) return false;
    if (depth_at[pc] == std.math.maxInt(u32)) {
        depth_at[pc] = depth;
        try work.append(gpa, pc);
        return true;
    }
    return depth_at[pc] == depth;
}

/// The instruction at `pc` when it is one the baseline JIT lowers, else null.
pub fn decode(code: []const u8, pc: u32, depth: u32) ?Insn {
    if (code[pc] >= op_count) return null;
    const op: Op = @fromBackingInt(code[pc]);
    var i: Insn = .{ .pc = pc, .op = op, .depth = depth, .next = pc + 1 };
    const rest = code.len - (pc + 1);
    const width: u32 = switch (op) {
        .ret_this => 0,
        .arg_local => 4,
        .undef, .null, .true, .false, .uninit, .pop, .dup, .swap, .ret, .ret_ctor, .throw, .arguments => 0,
        .this_raw, .this_sloppy, .new_target, .callee, .home, .pop_env, .clone_env => 0,
        .new_object, .get_elem, .set_elem => 0,
        .add, .sub, .mul, .div, .mod, .exp, .bitand, .bitor, .bitxor, .shl, .shr, .ushr => 0,
        .eq, .ne, .seq, .sne, .lt, .gt, .le, .ge => 0,
        .neg, .plus, .bitnot, .not, .typeof, .inc, .dec => 0,
        .int, .jump, .jump_if_false, .jump_if_true, .jump_if_nullish, .jump_if_not_undef => 4,
        .num, .load, .store, .arg, .load_global, .typeof_global, .call, .new => 2,
        .push_env, .closure, .declare_global, .new_array, .define, .str, .rest => 2,
        .store_global => 3,
        .load_checked, .store_checked, .inc_local, .dec_local, .get_prop, .get_method, .set_prop => 4,
        .load_env, .store_env => 3,
        .load_env_checked, .store_env_checked => 5,
        .add_local_int, .sub_local_int, .lt_local_int, .le_local_int => 8,
        .add_locals, .sub_locals, .lt_locals, .le_locals, .get_prop_local => 8,
        else => return null,
    };
    if (rest < width) return null;
    const at = pc + 1;
    switch (op) {
        .add_locals, .sub_locals, .lt_locals, .le_locals, .get_prop_local => {
            i.a = bc.read16(code, at);
            i.b = bc.read16(code, at + 2);
            i.c = bc.read16(code, at + 4);
            i.d = bc.read16(code, at + 6);
        },
        .add_local_int, .sub_local_int, .lt_local_int, .le_local_int => {
            i.a = bc.read16(code, at);
            i.b = bc.read16(code, at + 2);
            i.c = bc.read32(code, at + 4);
        },
        .int, .jump, .jump_if_false, .jump_if_true, .jump_if_nullish, .jump_if_not_undef => i.a = bc.read32(code, at),
        .num, .load, .store, .arg, .load_global, .typeof_global, .call, .new, .push_env, .closure, .declare_global, .new_array, .define, .str, .rest => i.a = bc.read16(code, at),
        .store_global => {
            i.a = bc.read16(code, at);
            i.b = code[at + 2];
        },
        .arg_local, .load_checked, .store_checked, .inc_local, .dec_local, .get_prop, .get_method, .set_prop => {
            i.a = bc.read16(code, at);
            i.b = bc.read16(code, at + 2);
        },
        .load_env, .store_env, .load_env_checked, .store_env_checked => {
            i.a = code[at];
            i.b = bc.read16(code, at + 1);
            if (width == 5) i.c = bc.read16(code, at + 3);
        },
        else => {},
    }
    i.next = at + width;
    return i;
}

pub const Effect = struct { pops: u32, pushes: u32 };

pub fn effect(i: Insn) Effect {
    return switch (i.op) {
        .add_locals, .sub_locals, .lt_locals, .le_locals, .get_prop_local => .{ .pops = 0, .pushes = 1 },
        .arg_local => .{ .pops = 0, .pushes = 0 },
        .ret_this => .{ .pops = 1, .pushes = 0 },
        .add_local_int, .sub_local_int, .lt_local_int, .le_local_int => .{ .pops = 0, .pushes = 1 },
        .undef, .null, .true, .false, .uninit, .int, .num, .load, .load_checked, .arg, .load_global, .typeof_global, .load_env, .load_env_checked => .{ .pops = 0, .pushes = 1 },
        .this_raw, .this_sloppy, .new_target, .callee, .home, .closure, .new_object, .str, .rest, .arguments => .{ .pops = 0, .pushes = 1 },
        .ret_ctor => .{ .pops = 2, .pushes = 0 },
        .pop, .store, .store_checked, .store_env, .store_env_checked, .store_global, .jump_if_false, .jump_if_true, .jump_if_nullish, .jump_if_not_undef, .ret, .throw => .{ .pops = 1, .pushes = 0 },
        .push_env, .pop_env, .clone_env, .declare_global, .inc_local, .dec_local => .{ .pops = 0, .pushes = 0 },
        .new_array => .{ .pops = i.a, .pushes = 1 },
        .new => .{ .pops = i.a + 1, .pushes = 1 },
        .set_elem => .{ .pops = 3, .pushes = 1 },
        .dup => .{ .pops = 1, .pushes = 2 },
        .swap => .{ .pops = 2, .pushes = 2 },
        .jump => .{ .pops = 0, .pushes = 0 },
        .call => .{ .pops = i.a + 2, .pushes = 1 },
        .get_prop, .get_method, .neg, .plus, .bitnot, .not, .typeof, .inc, .dec => .{ .pops = 1, .pushes = 1 },
        else => .{ .pops = 2, .pushes = 1 },
    };
}

/// The first function `src` declares, compiled the way the interpreter compiles it.
fn firstFunction(arena: std.mem.Allocator, src: []const u8) !*const Template {
    const file = switch (parse.parseScript(arena, src)) {
        .tree => |f| f,
        else => return error.TestUnexpectedResult,
    };
    return switch (try compile.compileScript(arena, arena, file, true)) {
        .template => |t| t.funcs[0],
        else => error.TestUnexpectedResult,
    };
}

fn analyzeFirst(src: []const u8) !Result {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    return analyze(std.testing.allocator, try firstFunction(arena.allocator(), src));
}

test "a loop's join points are reached at one depth" {
    const r = try analyzeFirst("function f() { let i = 0; while (i < 10) i++; return i; }");
    try std.testing.expect(r == .plan);
    defer r.plan.deinit(std.testing.allocator);
    var leaders: u32 = 0;
    for (r.plan.insns) |i| leaders += @intFromBool(i.leader);
    // The entry, the loop head and the exit.
    try std.testing.expect(leaders >= 3);
}

test "unsupported opcodes, handlers and suspension stay interpreted" {
    var r = try analyzeFirst("function f(o) { return delete o.x; }");
    try std.testing.expect(r == .reject and r.reject == .op);
    r = try analyzeFirst("function* f() {}");
    try std.testing.expect(r == .reject and r.reject == .shape);
    r = try analyzeFirst("function f() { try { g(); } catch (e) {} }");
    try std.testing.expect(r == .reject and r.reject == .shape);
}
