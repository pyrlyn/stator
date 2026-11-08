//! Bytecode to pyrlyn/jit IR (docs/ENGINE.md §3). The operand stack stays in the frame window, at
//! the depths `analyze.zig` computed, so every value the collector can see is where the
//! interpreter would have put it; registers hold only what one instruction is working on.
//!
//! Numbers and booleans take inline paths: both operands doubles for arithmetic and comparisons,
//! the two booleans for `!` and the conditional jumps. Anything else calls a helper that runs the
//! VM's own function for the operation (helpers.zig).

const std = @import("std");
const pj = @import("pyrlyn_jit");
const ir = pj.ir;
const rt = @import("../rt.zig");
const c = rt.c;
const bc = @import("../bytecode.zig");
const vm = @import("../vm.zig");
const analyze = @import("analyze.zig");
const h = @import("helpers.zig");
const Op = bc.Op;
const VReg = ir.VReg;

const mask: u64 = 0xFFF8_0000_0000_0000;
const canonical_nan: u64 = 0x7FF8_0000_0000_0000;

fn imm(v: u64) i64 {
    return @bitCast(v);
}

const Lowerer = struct {
    f: *ir.Func,
    t: *const bc.Template,
    ctx: VReg,
    w: VReg,
    argv: VReg,
    argc: VReg,
    cur: ?u32 = null,
    exit: u32,
    blocks: std.AutoHashMapUnmanaged(u32, u32) = .empty,

    fn block(l: *Lowerer) !u32 {
        return l.f.addBlock("b");
    }

    fn blockAt(l: *Lowerer, pc: u32) !u32 {
        const gop = try l.blocks.getOrPut(l.f.alloc(), pc);
        if (!gop.found_existing) gop.value_ptr.* = try l.block();
        return gop.value_ptr.*;
    }

    fn emit(l: *Lowerer, o: ir.Op) !void {
        try l.f.emit(l.cur.?, o);
    }

    /// Emits a `tag` instruction into a fresh destination register and answers the register;
    /// `payload.dst` is overwritten.
    fn def(l: *Lowerer, comptime tag: std.meta.Tag(ir.Op), payload: @FieldType(ir.Op, @tagName(tag))) !VReg {
        var p = payload;
        p.dst = l.f.newVReg();
        try l.emit(@unionInit(ir.Op, @tagName(tag), p));
        return p.dst;
    }

    fn konst(l: *Lowerer, v: i64) !VReg {
        return l.def(.@"const", .{ .dst = undefined, .imm = v });
    }

    /// Window index of operand `k`.
    fn slot(l: *Lowerer, k: u32) u32 {
        return vm.header + l.t.nlocals + k;
    }

    fn disp(index: u32) i32 {
        return @intCast(index * 8);
    }

    fn load(l: *Lowerer, index: u32) !VReg {
        return l.def(.load, .{ .dst = undefined, .base = l.w, .disp = disp(index) });
    }

    fn loadF(l: *Lowerer, index: u32) !VReg {
        return l.def(.load, .{ .dst = undefined, .base = l.w, .disp = disp(index), .ty = .f64 });
    }

    fn store(l: *Lowerer, index: u32, v: VReg) !void {
        try l.emit(.{ .store = .{ .base = l.w, .disp = disp(index), .src = v } });
    }

    fn storeConst(l: *Lowerer, index: u32, v: u64) !void {
        try l.store(index, try l.konst(imm(v)));
    }

    fn arith(l: *Lowerer, o: ir.Arith, a: VReg, b: VReg) !VReg {
        return l.def(.arith, .{ .op = o, .dst = undefined, .a = a, .b = b });
    }

    fn cbr(l: *Lowerer, cond: ir.CondCode, a: VReg, b: VReg, then: u32, else_: u32) !void {
        try l.emit(.{ .cbr = .{ .cond = cond, .a = a, .b = b, .then = then, .@"else" = else_ } });
        l.cur = null;
    }

    fn br(l: *Lowerer, to: u32) !void {
        try l.emit(.{ .br = to });
        l.cur = null;
    }

    fn callHelper(l: *Lowerer, comptime f: anytype, args: []const VReg) !VReg {
        return l.def(.call, .{ .dst = undefined, .addr = @intFromPtr(&f), .args = try l.f.alloc().dupe(VReg, args) });
    }

    /// Calls a helper and leaves through the exit block when it left an exception pending.
    fn helper(l: *Lowerer, comptime f: anytype, args: []const u64) !void {
        var vs: [8]VReg = undefined;
        vs[0] = l.ctx;
        for (args, 1..) |a, i| vs[i] = try l.konst(@intCast(a));
        const st = try l.callHelper(f, vs[0 .. args.len + 1]);
        try l.leaveOnThrow(st);
    }

    fn leaveOnThrow(l: *Lowerer, st: VReg) !void {
        const zero = try l.konst(0);
        const next = try l.block();
        try l.cbr(.ne, st, zero, l.exit, next);
        l.cur = next;
    }

    /// Jumps to `no` unless the window value at `index` is a double.
    fn guardDouble(l: *Lowerer, v: VReg, no: u32) !void {
        const m = try l.konst(imm(mask));
        const tag = try l.arith(.@"and", v, m);
        const yes = try l.block();
        try l.cbr(.eq, tag, m, no, yes);
        l.cur = yes;
    }

    /// The result's bits are left for a check that collapses every NaN into the canonical one,
    /// as `jsrt_number` does: x86-64's default NaN is `undefined`'s bit pattern.
    fn canonicalize(l: *Lowerer, index: u32, join: u32) !void {
        const bits = try l.load(index);
        const m = try l.konst(imm(mask));
        const tag = try l.arith(.@"and", bits, m);
        const fix = try l.block();
        try l.cbr(.eq, tag, m, fix, join);
        l.cur = fix;
        try l.storeConst(index, canonical_nan);
        try l.br(join);
    }

    fn binaryOp(l: *Lowerer, o: Op, s: u32) !void {
        // On two doubles loose and strict equality agree.
        const fast: union(enum) { none, arith: ir.TArith, cmp: ir.FCond } = switch (o) {
            inline .add, .sub, .mul, .div => |x| .{ .arith = @field(ir.TArith, @tagName(x)) },
            inline .lt, .gt, .le, .ge => |x| .{ .cmp = @field(ir.FCond, @tagName(x)) },
            .eq, .seq => .{ .cmp = .eq },
            .ne, .sne => .{ .cmp = .ne },
            else => .none,
        };
        if (fast == .none) return l.helper(h.binary, &.{ s, @backingInt(o) });

        const slow = try l.block();
        const join = try l.block();
        try l.guardDouble(try l.load(s), slow);
        try l.guardDouble(try l.load(s + 1), slow);
        const a = try l.loadF(s);
        const b = try l.loadF(s + 1);
        switch (fast) {
            .none => unreachable,
            .arith => |ta| try l.typedF64(ta, a, b, s, join),
            .cmp => |cond| {
                const d = try l.def(.fcmp, .{ .cond = cond, .ty = .f64, .dst = undefined, .a = a, .b = b });
                // JSRT_TRUE is JSRT_FALSE + 1.
                try l.store(s, try l.arith(.add, d, try l.konst(imm(c.JSRT_FALSE))));
                try l.br(join);
            },
        }
        try l.slowPath(slow, join, h.binary, o, s);
    }

    /// `a op b` in f64 into window slot `s`, then on to `join` with its NaN canonical.
    fn typedF64(l: *Lowerer, o: ir.TArith, a: VReg, b: VReg, s: u32, join: u32) !void {
        const d = try l.def(.typed, .{ .op = o, .ty = .f64, .dst = undefined, .a = a, .b = b });
        try l.emit(.{ .store = .{ .base = l.w, .disp = disp(s), .src = d, .ty = .f64 } });
        try l.canonicalize(s, join);
    }

    /// The `slow` block calls the operator's helper; both paths meet at `join`.
    fn slowPath(l: *Lowerer, slow: u32, join: u32, comptime f: anytype, o: Op, s: u32) !void {
        l.cur = slow;
        try l.helper(f, &.{ s, @backingInt(o) });
        try l.br(join);
        l.cur = join;
    }

    fn unaryOp(l: *Lowerer, o: Op, s: u32) !void {
        const slow = try l.block();
        const join = try l.block();
        switch (o) {
            .inc, .dec, .neg => {
                try l.guardDouble(try l.load(s), slow);
                const x = try l.loadF(s);
                const by: f64 = if (o == .neg) -1 else 1;
                const k = try l.def(.fconst, .{ .dst = undefined, .ty = .f64, .bits = @bitCast(by) });
                // -x is x * -1, so that -0 and +0 swap.
                const ta: ir.TArith = switch (o) {
                    .inc => .add,
                    .dec => .sub,
                    else => .mul,
                };
                try l.typedF64(ta, x, k, s, join);
            },
            .not => {
                const v = try l.load(s);
                const f = try l.konst(imm(c.JSRT_FALSE));
                const b = try l.arith(.@"and", v, try l.konst(~@as(i64, 1)));
                const yes = try l.block();
                try l.cbr(.eq, b, f, yes, slow);
                l.cur = yes;
                try l.store(s, try l.arith(.xor, v, try l.konst(1)));
                try l.br(join);
            },
            else => try l.br(slow),
        }
        try l.slowPath(slow, join, h.unary, o, s);
    }

    fn condJump(l: *Lowerer, i: analyze.Insn) !void {
        const v = try l.load(l.slot(i.depth - 1));
        const target = try l.blockAt(i.a);
        const fall = try l.blockAt(i.next);
        const on_true, const on_false = if (i.op == .jump_if_true) .{ target, fall } else .{ fall, target };
        const not_true = try l.block();
        try l.cbr(.eq, v, try l.konst(imm(c.JSRT_TRUE)), on_true, not_true);
        l.cur = not_true;
        const other = try l.block();
        try l.cbr(.eq, v, try l.konst(imm(c.JSRT_FALSE)), on_false, other);
        l.cur = other;
        const t = try l.callHelper(h.truthy, &.{v});
        try l.cbr(.ne, t, try l.konst(0), on_true, on_false);
    }

    /// `jump_if_nullish` jumps on undefined or null, `jump_if_not_undef` on anything but undefined.
    fn undefJump(l: *Lowerer, i: analyze.Insn) !void {
        const v = try l.load(l.slot(i.depth - 1));
        const target = try l.blockAt(i.a);
        const fall = try l.blockAt(i.next);
        const undef = try l.konst(imm(c.JSRT_UNDEFINED));
        if (i.op == .jump_if_not_undef) return l.cbr(.ne, v, undef, target, fall);
        const not_undef = try l.block();
        try l.cbr(.eq, v, undef, target, not_undef);
        l.cur = not_undef;
        try l.cbr(.eq, v, try l.konst(imm(c.JSRT_NULL)), target, fall);
    }

    fn arg(l: *Lowerer, i: analyze.Insn) !void {
        const to = l.slot(i.depth);
        const has = try l.block();
        const none = try l.block();
        const join = try l.block();
        try l.cbr(.ugt, l.argc, try l.konst(i.a), has, none);
        l.cur = has;
        try l.store(to, try l.def(.load, .{ .dst = undefined, .base = l.argv, .disp = @intCast(i.a * 8) }));
        try l.br(join);
        l.cur = none;
        try l.storeConst(to, c.JSRT_UNDEFINED);
        try l.br(join);
        l.cur = join;
    }

    /// Reads local `local` and leaves with a ReferenceError when it is still in its TDZ.
    fn checkedLocal(l: *Lowerer, local: u32, key: u32) !VReg {
        const v = try l.load(vm.header + local);
        const tdz = try l.block();
        const ok = try l.block();
        try l.cbr(.eq, v, try l.konst(imm(rt.uninitialized)), tdz, ok);
        l.cur = tdz;
        _ = try l.callHelper(h.tdz, &.{ l.ctx, try l.konst(key) });
        try l.br(l.exit);
        l.cur = ok;
        return v;
    }

    fn insn(l: *Lowerer, i: analyze.Insn) !void {
        const d = i.depth;
        switch (i.op) {
            .undef => try l.storeConst(l.slot(d), c.JSRT_UNDEFINED),
            .null => try l.storeConst(l.slot(d), c.JSRT_NULL),
            .true => try l.storeConst(l.slot(d), c.JSRT_TRUE),
            .false => try l.storeConst(l.slot(d), c.JSRT_FALSE),
            .uninit => try l.storeConst(l.slot(d), rt.uninitialized),
            .callee => try l.store(l.slot(d), try l.load(0)),
            .this_raw => try l.store(l.slot(d), try l.load(1)),
            .new_target => try l.store(l.slot(d), try l.load(2)),
            .this_sloppy => try l.helper(h.thisSloppy, &.{l.slot(d)}),
            .home => try l.helper(h.home, &.{l.slot(d)}),
            .str => try l.helper(h.str, &.{ l.slot(d), i.a }),
            .rest => try l.helper(h.rest, &.{ l.slot(d), i.a }),
            .arguments => try l.helper(h.arguments, &.{l.slot(d)}),
            .ret_ctor => {
                try l.helper(h.retCtor, &.{l.slot(d - 2)});
                try l.emit(.{ .ret = try l.load(l.slot(d - 2)) });
                l.cur = null;
            },
            .jump_if_nullish, .jump_if_not_undef => try l.undefJump(i),
            .push_env => try l.helper(h.pushEnv, &.{i.a}),
            .pop_env => try l.helper(h.popEnv, &.{}),
            .clone_env => try l.helper(h.cloneEnv, &.{}),
            .closure => try l.helper(h.closure, &.{ l.slot(d), i.a }),
            .declare_global => try l.helper(h.declareGlobal, &.{i.a}),
            .store_global => try l.helper(h.storeGlobal, &.{ l.slot(d - 1), i.a, i.b }),
            .set_prop => try l.helper(h.setProp, &.{ l.slot(d - 2), i.a, i.b }),
            .get_elem => try l.helper(h.getElem, &.{l.slot(d - 2)}),
            .set_elem => try l.helper(h.setElem, &.{l.slot(d - 3)}),
            .new_object => try l.helper(h.newObject, &.{l.slot(d)}),
            .new_array => try l.helper(h.newArray, &.{ l.slot(d - i.a), i.a }),
            .define => try l.helper(h.define, &.{ l.slot(d - 2), i.a }),
            .new => try l.helper(h.construct, &.{ l.slot(d - i.a - 1), i.a }),
            .throw => {
                _ = try l.callHelper(h.throw, &.{ l.ctx, try l.konst(l.slot(d - 1)) });
                try l.br(l.exit);
            },
            .int => try l.storeConst(l.slot(d), rt.number(@floatFromInt(@as(i32, @bitCast(i.a))))),
            .num => try l.storeConst(l.slot(d), rt.number(l.t.numbers[i.a])),
            .pop => {},
            .dup => try l.store(l.slot(d), try l.load(l.slot(d - 1))),
            .swap => {
                const a = try l.load(l.slot(d - 2));
                const b = try l.load(l.slot(d - 1));
                try l.store(l.slot(d - 2), b);
                try l.store(l.slot(d - 1), a);
            },
            .load => try l.store(l.slot(d), try l.load(vm.header + i.a)),
            .store => try l.store(vm.header + i.a, try l.load(l.slot(d - 1))),
            .load_checked => {
                const v = try l.checkedLocal(i.a, i.b);
                try l.store(l.slot(d), v);
            },
            .store_checked => {
                _ = try l.checkedLocal(i.a, i.b);
                try l.store(vm.header + i.a, try l.load(l.slot(d - 1)));
            },
            .arg => try l.arg(i),
            .load_global, .typeof_global => try l.helper(h.loadGlobal, &.{ l.slot(d), i.a, @intFromBool(i.op == .typeof_global) }),
            .load_env => try l.helper(h.loadEnv, &.{ l.slot(d), i.a, i.b, 0 }),
            .load_env_checked => try l.helper(h.loadEnv, &.{ l.slot(d), i.a, i.b, i.c + 1 }),
            .store_env => try l.helper(h.storeEnv, &.{ l.slot(d - 1), i.a, i.b, 0 }),
            .store_env_checked => try l.helper(h.storeEnv, &.{ l.slot(d - 1), i.a, i.b, i.c + 1 }),
            .get_prop => try l.helper(h.getProp, &.{ l.slot(d - 1), i.a, i.b }),
            .call => try l.helper(h.call, &.{ l.slot(d - i.a - 2), i.a }),
            .add, .sub, .mul, .div, .mod, .exp, .bitand, .bitor, .bitxor, .shl, .shr, .ushr, .eq, .ne, .seq, .sne, .lt, .gt, .le, .ge => try l.binaryOp(i.op, l.slot(d - 2)),
            .neg, .plus, .bitnot, .not, .typeof, .inc, .dec => try l.unaryOp(i.op, l.slot(d - 1)),
            .jump => try l.br(try l.blockAt(i.a)),
            .jump_if_false, .jump_if_true => try l.condJump(i),
            .ret => {
                try l.emit(.{ .ret = try l.load(l.slot(d - 1)) });
                l.cur = null;
            },
            else => unreachable,
        }
    }
};

/// Lowers a plan into `f`: one parameter, the `helpers.Ctx` pointer; the result is the value the
/// call answers, or undefined with the exception pending.
pub fn lower(f: *ir.Func, t: *const bc.Template, plan: analyze.Plan) !void {
    f.name = "js";
    f.params = 1;
    const ctx = f.newVReg();
    const entry = try f.addBlock("entry");
    const exit = try f.addBlock("exit");
    var l: Lowerer = .{ .f = f, .t = t, .ctx = ctx, .w = f.newVReg(), .argv = f.newVReg(), .argc = f.newVReg(), .exit = exit };

    l.cur = exit;
    try l.emit(.{ .ret = try l.konst(imm(c.JSRT_UNDEFINED)) });

    l.cur = entry;
    try l.emit(.{ .load = .{ .dst = l.w, .base = ctx, .disp = @offsetOf(h.Ctx, "w") } });
    try l.emit(.{ .load = .{ .dst = l.argv, .base = ctx, .disp = @offsetOf(h.Ctx, "argv") } });
    try l.emit(.{ .load = .{ .dst = l.argc, .base = ctx, .disp = @offsetOf(h.Ctx, "argc") } });

    for (plan.insns) |i| {
        if (i.leader) {
            const b = try l.blockAt(i.pc);
            if (l.cur != null) try l.br(b);
            l.cur = b;
        }
        try l.insn(i);
    }
}
