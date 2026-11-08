//! Bytecode to pyrlyn/jit IR (docs/ENGINE.md §3). The operand stack stays in the frame window, at
//! the depths `analyze.zig` computed, so every value the collector can see is where the
//! interpreter would have put it; registers hold only what one instruction is working on.
//!
//! Numbers and booleans take inline paths: both operands doubles for arithmetic and comparisons,
//! the two booleans for `!` and the conditional jumps. Anything else calls a helper that runs the
//! VM's own function for the operation (helpers.zig).

const std = @import("std");
const builtin = @import("builtin");
const pj = @import("pyrlyn_jit");
const ir = pj.ir;
const rt = @import("../rt.zig");
const c = rt.c;
const bc = @import("../bytecode.zig");
const vm = @import("../vm.zig");
const builtins = @import("../builtins.zig");
const analyze = @import("analyze.zig");
const h = @import("helpers.zig");
const Op = bc.Op;
const VReg = ir.VReg;

const mask: u64 = 0xFFF8_0000_0000_0000;
const canonical_nan: u64 = 0x7FF8_0000_0000_0000;
/// The sign, exponent, quiet bit and tag of a boxed value (docs/VALUE.md).
const tag_bits: u64 = 0xFFFF_0000_0000_0000;
const payload_mask: u64 = 0x0000_FFFF_FFFF_FFFF;

fn boxTag(tag: u64) u64 {
    return mask | tag << 48;
}

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
        const addr = if (builtin.is_test) @intFromPtr(h.counted(f)) else @intFromPtr(&f);
        return l.def(.call, .{ .dst = undefined, .addr = addr, .args = try l.f.alloc().dupe(VReg, args) });
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
    /// as `jsrt_number` does: x86-64's default NaN is `undefined`'s bit pattern. AArch64 needs no
    /// check: its default NaN is the canonical one, and a NaN operand, canonical because every
    /// boxed double is, propagates unchanged, sign included.
    fn canonicalize(l: *Lowerer, index: u32, join: u32) !void {
        if (builtin.cpu.arch == .aarch64) return l.br(join);
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
            // ToNumeric of a double is the double: `i++` starts with it.
            .plus => {
                try l.guardDouble(try l.load(s), slow);
                try l.br(join);
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

    /// Jumps to `no` unless `a` is `want`.
    fn guardEq(l: *Lowerer, a: VReg, want: u64, no: u32) !void {
        const yes = try l.block();
        try l.cbr(.ne, a, try l.konst(imm(want)), no, yes);
        l.cur = yes;
    }

    fn ptrOf(l: *Lowerer, v: VReg) !VReg {
        return l.arith(.@"and", v, try l.konst(imm(payload_mask)));
    }

    /// The object pointer of `v` when it is a dynamic object, else on to `no`.
    fn dynObj(l: *Lowerer, v: VReg, no: u32) !VReg {
        try l.guardEq(try l.arith(.@"and", v, try l.konst(imm(tag_bits))), boxTag(c.JSRT_TAG_OBJECT), no);
        const p = try l.ptrOf(v);
        try l.guardEq(try l.def(.load, .{ .dst = undefined, .base = p, .disp = 0 }), @intFromPtr(&c.jsrt_class_dynamic), no);
        return p;
    }

    /// The address of the slot of dynamic object `p` that the site's cache `ic` names, when `p` has
    /// the shape the cache recorded; else on to `slow`. A cache is filled only from an
    /// own-property hit on that shape, so a match is the site's key.
    fn cachedSlot(l: *Lowerer, p: VReg, ic: *const c.JSRTIC, slow: u32) !VReg {
        const icp = try l.konst(@intCast(@intFromPtr(ic)));
        const shape = try l.def(.load, .{ .dst = undefined, .base = p, .disp = @offsetOf(c.JSRTDynObject, "shape") });
        const want = try l.def(.load, .{ .dst = undefined, .base = icp, .disp = @offsetOf(c.JSRTIC, "shape") });
        const hit = try l.block();
        try l.cbr(.ne, shape, want, slow, hit);
        l.cur = hit;
        // `offset` is a u32 and the IR loads 64 bits: keep the low half.
        const raw = try l.def(.load, .{ .dst = undefined, .base = icp, .disp = @offsetOf(c.JSRTIC, "offset") });
        const off = try l.arith(.shl, try l.arith(.@"and", raw, try l.konst(0xFFFF_FFFF)), try l.konst(3));
        const slots = try l.def(.load, .{ .dst = undefined, .base = p, .disp = @offsetOf(c.JSRTDynObject, "slots") });
        return l.arith(.add, slots, off);
    }

    /// Goes on to `slow` when slot value `v` is an accessor cell, whose read or write is a call.
    fn unlessAccessor(l: *Lowerer, v: VReg, slow: u32) !void {
        const done = try l.block();
        const object = try l.block();
        try l.cbr(.eq, try l.arith(.@"and", v, try l.konst(imm(tag_bits))), try l.konst(imm(boxTag(c.JSRT_TAG_OBJECT))), object, done);
        l.cur = object;
        const cls = try l.def(.load, .{ .dst = undefined, .base = try l.ptrOf(v), .disp = 0 });
        try l.cbr(.eq, cls, try l.konst(@intCast(@intFromPtr(&c.jsrt_class_accessor))), slow, done);
        l.cur = done;
    }

    /// The value in the slot `cachedSlot` finds, when it is no accessor.
    fn cachedRead(l: *Lowerer, p: VReg, ic: *const c.JSRTIC, slow: u32) !VReg {
        const v = try l.def(.load, .{ .dst = undefined, .base = try l.cachedSlot(p, ic, slow), .disp = 0 });
        try l.unlessAccessor(v, slow);
        return v;
    }

    /// `obj.key = value` (obj value at `s` -> value at `s`) through the site's inline cache: an
    /// unfrozen dynamic object of the cached shape whose slot holds no accessor is written in
    /// place, after the collector's write barrier on the object.
    fn setProp(l: *Lowerer, i: analyze.Insn) !void {
        const s = l.slot(i.depth - 2);
        const slow = try l.block();
        const p = try l.dynObj(try l.load(s), slow);
        const frozen = try l.def(.load, .{ .dst = undefined, .base = p, .disp = @offsetOf(c.JSRTDynObject, "frozen") });
        try l.guardEq(try l.arith(.@"and", frozen, try l.konst(0xFF)), 0, slow);
        const at = try l.cachedSlot(p, &l.t.ics[i.b], slow);
        try l.unlessAccessor(try l.def(.load, .{ .dst = undefined, .base = at, .disp = 0 }), slow);
        // The owner, not its slot buffer: an object already dirty and named by its own address is
        // the barrier's lock-free case.
        _ = try l.callHelper(c.jsrt_gc_write, &.{p});
        const v = try l.load(s + 1);
        try l.emit(.{ .store = .{ .base = at, .disp = 0, .src = v } });
        try l.fastOrHelper(s, v, slow, h.setProp, &.{ s, i.a, i.b });
    }

    /// Ends a fast path that answered `v` into slot `s`; block `slow` answers through helper `f`.
    fn fastOrHelper(l: *Lowerer, s: u32, v: VReg, slow: u32, comptime f: anytype, args: []const u64) !void {
        const join = try l.block();
        try l.store(s, v);
        try l.br(join);
        l.cur = slow;
        try l.helper(f, args);
        try l.br(join);
        l.cur = join;
    }

    /// `obj.key` through the site's inline cache, the helper filling it on a miss.
    fn getProp(l: *Lowerer, i: analyze.Insn) !void {
        const s = l.slot(i.depth - 1);
        // `constructor` has answers of its own before any shape is asked (vm.getProp).
        if (std.mem.eql(u8, std.mem.span(l.t.keys[i.a]), "constructor")) return l.helper(h.getProp, &.{ s, i.a, i.b });
        const slow = try l.block();
        const v = try l.cachedRead(try l.dynObj(try l.load(s), slow), &l.t.ics[i.b], slow);
        try l.fastOrHelper(s, v, slow, h.getProp, &.{ s, i.a, i.b });
    }

    /// A global name read from the global object through the key's cache, which the interpreter
    /// and the helper fill (vm.loadGlobal).
    fn globalLoad(l: *Lowerer, i: analyze.Insn) !void {
        const s = l.slot(i.depth);
        const slow = try l.block();
        const g = try l.konst(imm(builtins.global() & payload_mask));
        try l.fastOrHelper(s, try l.cachedRead(g, &l.t.global_ics[i.a], slow), slow, h.loadGlobal, &.{ s, i.a, 0 });
    }

    /// `this` in a sloppy function: the receiver, or the global object for undefined and null.
    fn thisSloppy(l: *Lowerer, s: u32) !void {
        const v = try l.load(1);
        const global = try l.block();
        const join = try l.block();
        const not_undef = try l.block();
        const ok = try l.block();
        try l.cbr(.eq, v, try l.konst(imm(c.JSRT_UNDEFINED)), global, not_undef);
        l.cur = not_undef;
        try l.cbr(.eq, v, try l.konst(imm(c.JSRT_NULL)), global, ok);
        l.cur = ok;
        try l.store(s, v);
        try l.br(join);
        l.cur = global;
        try l.storeConst(s, builtins.global());
        try l.br(join);
        l.cur = join;
    }

    /// A constructible function's return: a plain call (no new.target) answers the value as is.
    fn retCtor(l: *Lowerer, s: u32) !void {
        const plain = try l.block();
        const construct = try l.block();
        try l.cbr(.eq, try l.load(2), try l.konst(imm(c.JSRT_UNDEFINED)), plain, construct);
        l.cur = plain;
        try l.emit(.{ .ret = try l.load(s) });
        l.cur = construct;
        try l.helper(h.retCtor, &.{s});
        try l.emit(.{ .ret = try l.load(s) });
        l.cur = null;
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
            .this_sloppy => try l.thisSloppy(l.slot(d)),
            .home => try l.helper(h.home, &.{l.slot(d)}),
            .str => try l.helper(h.str, &.{ l.slot(d), i.a }),
            .rest => try l.helper(h.rest, &.{ l.slot(d), i.a }),
            .arguments => try l.helper(h.arguments, &.{l.slot(d)}),
            .ret_ctor => try l.retCtor(l.slot(d - 2)),
            .jump_if_nullish, .jump_if_not_undef => try l.undefJump(i),
            .push_env => try l.helper(h.pushEnv, &.{i.a}),
            .pop_env => try l.helper(h.popEnv, &.{}),
            .clone_env => try l.helper(h.cloneEnv, &.{}),
            .closure => try l.helper(h.closure, &.{ l.slot(d), i.a }),
            .declare_global => try l.helper(h.declareGlobal, &.{i.a}),
            .store_global => try l.helper(h.storeGlobal, &.{ l.slot(d - 1), i.a, i.b }),
            .set_prop => try l.setProp(i),
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
            .load_global => try l.globalLoad(i),
            .typeof_global => try l.helper(h.loadGlobal, &.{ l.slot(d), i.a, 1 }),
            .load_env => try l.helper(h.loadEnv, &.{ l.slot(d), i.a, i.b, 0 }),
            .load_env_checked => try l.helper(h.loadEnv, &.{ l.slot(d), i.a, i.b, i.c + 1 }),
            .store_env => try l.helper(h.storeEnv, &.{ l.slot(d - 1), i.a, i.b, 0 }),
            .store_env_checked => try l.helper(h.storeEnv, &.{ l.slot(d - 1), i.a, i.b, i.c + 1 }),
            .get_prop => try l.getProp(i),
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

    const dead = try deadStores(f.alloc(), t, plan.insns);
    for (plan.insns, dead) |i, skip| {
        if (i.leader) {
            const b = try l.blockAt(i.pc);
            if (l.cur != null) try l.br(b);
            l.cur = b;
        }
        if (!skip) try l.insn(i);
    }
}

/// Pairs of a push without effects and a store into a local nothing reads, both left out: the
/// prologue's `this`, `new.target`, home object and callee in a function that names none of them.
fn deadStores(alloc: std.mem.Allocator, t: *const bc.Template, insns: []const analyze.Insn) ![]bool {
    const read = try alloc.alloc(bool, t.nlocals);
    @memset(read, false);
    for (insns) |i| switch (i.op) {
        .load, .load_checked, .store_checked => read[i.a] = true,
        else => {},
    };
    const dead = try alloc.alloc(bool, insns.len);
    @memset(dead, false);
    if (insns.len < 2) return dead;
    for (insns[0 .. insns.len - 1], insns[1..], 0..) |x, y, k| {
        const pure = switch (x.op) {
            .undef, .null, .true, .false, .int, .num, .this_raw, .this_sloppy, .new_target, .home, .callee => true,
            else => false,
        };
        if (pure and y.op == .store and !y.leader and y.pc == x.next and !read[y.a]) {
            dead[k] = true;
            dead[k + 1] = true;
        }
    }
    return dead;
}
