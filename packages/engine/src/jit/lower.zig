//! Bytecode to pyrlyn/zjit IR (docs/ENGINE.md §3). The operand stack stays in the frame window, at
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
const layout = @import("layout.zig");
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

/// What binary operator `o` is on two doubles, where loose and strict equality agree.
fn doubleForm(o: Op) union(enum) { none, arith: ir.TArith, cmp: ir.FCond } {
    return switch (o) {
        inline .add, .sub, .mul, .div => |x| .{ .arith = @field(ir.TArith, @tagName(x)) },
        inline .lt, .gt, .le, .ge => |x| .{ .cmp = @field(ir.FCond, @tagName(x)) },
        .eq, .seq => .{ .cmp = .eq },
        .ne, .sne => .{ .cmp = .ne },
        else => .none,
    };
}

/// 2^53: a double of a smaller magnitude that is an integer converts to i64 and back exactly.
const integer_limit: f64 = 9007199254740992.0;

/// AArch64 only: an x86-64 result must be read back from the window to make its NaN canonical
/// (`canonicalize`), which is the load the fast chain exists to avoid.
pub const fast_chain = builtin.cpu.arch == .aarch64;

/// What the fast chain knows of the value a window slot holds.
const Known = struct {
    /// Its bits in an integer register.
    bits: ?VReg = null,
    /// Its bits in a float register.
    f: ?VReg = null,
    /// It is a double.
    double: bool = false,
    /// It is not the TDZ marker.
    live: bool = false,
    /// The double, when the bytecode names it.
    konst: ?f64 = null,
    /// Its bits, when the bytecode names a value that is no number (`literalBits`). No register
    /// keeps them: they are as cheap to make again as to load.
    word: ?u64 = null,
    /// It is `Lowerer.objects[obj]`.
    obj: ?u32 = null,
    /// The address of the dynamic object it is, or of the array it is.
    dyn: ?VReg = null,
    array: ?VReg = null,
    /// The window does not hold it yet: one of the above has the value, and `save` stores it
    /// before anything but the chain reads the slot. An operand popped before then is never
    /// stored.
    unsaved: bool = false,
    /// The window slot `bits` was loaded from. While that slot still holds them (`atHome`), a
    /// copy that waits for its own slot is read from there.
    home: ?u32 = null,

    /// Whether a register or the bytecode has the value, so that the window need not.
    fn held(k: Known) bool {
        return k.bits != null or k.f != null or k.konst != null or k.word != null;
    }
};

/// The properties the fast chain follows in one object literal; a longer one has no form.
const max_fields = 8;

/// An object a literal made in the run of bytecode being lowered. Until an instruction without
/// a form runs, nothing but the chain has touched it, so its shape and what its slots hold are
/// known here: a property is defined, written and read without asking the shape table, a cache
/// or the object. The chain calls nothing, so no collection has run since the object was
/// allocated: it is as dirty as it was born, and a store into it needs no write barrier.
const Object = struct {
    /// Its address.
    p: VReg,
    shape: *c.JSRTShape,
    /// The slots it was allocated with, which follow it (jsrt_dynobj_new_sized).
    capacity: u32,
    /// Its shape word holds `shape`. The chain stores the shape a literal ends on, not the ones
    /// it passes through, and only where something else may look (`flush`).
    stored: bool = false,
    /// By slot, whether the slot holds a value. The run a literal is taken from is not zeroed,
    /// and a slot a member fills at once is never cleared first: the others are, where
    /// something else may look (`flush`).
    filled: std.StaticBitSet(max_fields) = .empty,
    /// By slot, with a register or a constant each.
    fields: [max_fields]Known = undefined,

    /// Its shape word and every slot hold what the runtime may read.
    fn whole(o: Object) bool {
        return o.stored and o.filled.count() >= o.capacity;
    }
};

/// Where captured variable `slot` is in its environment: the slots are a flexible array member,
/// which follows the struct.
fn envSlot(slot: u32) i32 {
    return @intCast(@sizeOf(c.JSRTEnv) + slot * @sizeOf(rt.Value));
}

/// Where slot `slot` of a dynamic object's own, which follow it, is from its address.
fn ownSlot(slot: u32) i32 {
    return @intCast(@sizeOf(c.JSRTDynObject) + slot * @sizeOf(rt.Value));
}

/// The value an instruction that pushes a constant other than a number pushes.
fn literalBits(op: Op) u64 {
    return switch (op) {
        .undef => c.JSRT_UNDEFINED,
        .null => c.JSRT_NULL,
        .true => c.JSRT_TRUE,
        .false => c.JSRT_FALSE,
        .uninit => rt.uninitialized,
        else => unreachable,
    };
}

/// A key the runtime answers before it asks the shape (vm.getProp, vm.setProp).
fn plainKey(key: [*:0]const u8) bool {
    const name = std.mem.span(key);
    return !std.mem.eql(u8, name, "constructor") and !std.mem.eql(u8, name, "__proto__");
}

/// The shape of an instruction's form on the fast chain (`Lowerer.fast`); `none` has no form.
const Form = enum { none, literal, number, pop, swap, dup, frame, load, store, step, local_int, locals, add_store, binary, prop, elem, local_prop, jump, cond_jump };

fn form(o: Op) Form {
    return switch (o) {
        .undef, .null, .true, .false, .uninit => .literal,
        .int, .num => .number,
        .pop => .pop,
        .swap => .swap,
        .dup => .dup,
        .callee, .this_raw, .new_target => .frame,
        .load, .load_checked => .load,
        .store, .store_checked => .store,
        .inc_local, .dec_local => .step,
        .add_local_int, .sub_local_int, .lt_local_int, .le_local_int => .local_int,
        .add_locals, .sub_locals, .lt_locals, .le_locals => .locals,
        .add_store_local => .add_store,
        .add, .sub, .mul, .div, .mod, .eq, .ne, .seq, .sne, .lt, .gt, .le, .ge => .binary,
        .get_prop, .get_prop_local => .prop,
        .get_elem, .get_elem_locals => .elem,
        .lt_local_prop, .le_local_prop => .local_prop,
        .jump => .jump,
        .jump_if_false, .jump_if_true => .cond_jump,
        else => .none,
    };
}

/// A key the chain reads through the site's inline cache. `length` is as often asked of an
/// array or a string, which no cache answers for.
fn cachedKey(key: [*:0]const u8) bool {
    return plainKey(key) and !isLength(key);
}

fn isLength(key: [*:0]const u8) bool {
    return std.mem.eql(u8, std.mem.span(key), "length");
}

/// Whether the fast chain takes `i` whatever it meets: a guard may leave for the generic code,
/// but the instruction has a form.
fn chained(t: *const bc.Template, i: analyze.Insn) bool {
    return switch (form(i.op)) {
        .none => false,
        .prop => cachedKey(t.keys[if (i.op == .get_prop_local) i.c else i.a]),
        .local_prop => isLength(t.keys[i.tail[0]]),
        else => true,
    };
}

/// Whether the fast chain may take `o` though `chained` cannot say so: a form of
/// `Lowerer.literal`, which depends on what the chain knows of the operands where it meets
/// the instruction.
fn followed(o: Op) bool {
    return switch (o) {
        .new_object, .define, .set_prop, .get_prop, .get_prop_local, .store_env, .store_env_checked, .load_env, .load_env_checked => true,
        else => false,
    };
}

/// Whether the fast chain takes every instruction of `insns[head .. last + 1]`, a loop: asked
/// by lowering them into a function that is thrown away, with the chain knowing what it will
/// know when they are lowered for good.
fn takenWhole(f: *ir.Func, t: *const bc.Template, insns: []const analyze.Insn, dead: []const bool, head: usize, last: usize) !bool {
    var scratch = ir.Func.init(f.alloc());
    defer scratch.deinit();
    var l: Lowerer = .{ .f = &scratch, .t = t, .ctx = scratch.newVReg(), .w = scratch.newVReg(), .argv = scratch.newVReg(), .argc = scratch.newVReg(), .exit = try scratch.addBlock("exit"), .insns = insns };
    for (insns[head .. last + 1], dead[head .. last + 1], head..) |i, skip, at| {
        l.at = at;
        if (i.leader or l.cur == null) {
            l.cur = try l.block();
            l.forget();
        }
        if (l.fused) {
            l.fused = false;
            continue;
        }
        if (skip) continue;
        switch (form(i.op)) {
            // With carried locals a jump always has a form, and it ends the block.
            .jump, .cond_jump => l.cur = null,
            else => if (!try l.fast(i)) return false,
        }
    }
    return true;
}

/// The float registers are few, and a loop with more numeric locals than this is rare.
const max_carried = 8;

/// A local of a `Loop` and the float register it is carried in.
const Carried = struct { local: u32, v: VReg };

/// A loop whose every instruction has a form on the fast chain (`chained`, `takenWhole`), so
/// its body makes no call. It is lowered once more with the locals it computes with in
/// registers from one iteration to the next (docs/ENGINE.md §3).
const Loop = struct {
    /// The pcs of its first and last instructions.
    from: u32,
    to: u32,
    carried: []const Carried,

    fn holds(loop: *const Loop, pc: u32) bool {
        return loop.from <= pc and pc <= loop.to;
    }

    fn carries(loop: *const Loop, v: VReg) bool {
        for (loop.carried) |x| if (x.v == v) return true;
        return false;
    }
};

/// The locals `region` computes with and stores nothing but doubles into, each with a register.
fn carriedIn(f: *ir.Func, t: *const bc.Template, region: []const analyze.Insn) ![]Carried {
    const alloc = f.alloc();
    var deep: u32 = 0;
    for (region) |i| deep = @max(deep, i.depth);
    // By operand: the local it was loaded from, and whether the chain knows it is a double.
    const from = try alloc.alloc(?u32, deep + 2);
    const double = try alloc.alloc(bool, deep + 2);
    const used = try alloc.alloc(bool, t.nlocals);
    @memset(used, false);
    for (region) |i| {
        const d = i.depth;
        if (i.leader) @memset(from, null);
        switch (form(i.op)) {
            .load => from[d] = i.a,
            .dup => from[d] = from[d - 1],
            .swap => std.mem.swap(?u32, &from[d - 2], &from[d - 1]),
            .step, .local_int => used[i.a] = true,
            .locals => {
                used[i.a] = true;
                used[i.c] = true;
            },
            .add_store, .binary => {
                // Equality is as often asked of objects, which a register cannot carry.
                if (doubleForm(i.op) != .cmp or (i.op != .eq and i.op != .ne and i.op != .seq and i.op != .sne)) {
                    for (from[d - 2 .. d]) |local| if (local) |x| {
                        used[x] = true;
                    };
                }
                from[d - 2] = null;
            },
            .literal, .number, .frame => from[d] = null,
            // An index and the number a length is compared with are computed with as doubles.
            .elem => {
                if (i.op == .get_elem_locals) {
                    used[i.c] = true;
                } else if (from[d - 1]) |x| {
                    used[x] = true;
                }
                from[if (i.op == .get_elem_locals) d else d - 2] = null;
            },
            .local_prop => {
                used[i.a] = true;
                from[d] = null;
            },
            .prop => from[if (i.op == .get_prop_local) d else d - 1] = null,
            .none => switch (i.op) {
                .new_object, .load_env, .load_env_checked => from[d] = null,
                // An assignment's value is what was assigned.
                .set_prop => from[d - 2] = from[d - 1],
                else => {},
            },
            .pop, .store, .jump, .cond_jump => {},
        }
    }
    // A store of anything else takes the local out, and with it what is loaded from it.
    var changed = true;
    while (changed) {
        changed = false;
        for (region) |i| {
            const d = i.depth;
            if (i.leader) @memset(double, false);
            switch (form(i.op)) {
                .number, .step => double[d] = true,
                .literal, .frame => double[d] = false,
                .load => double[d] = used[i.a],
                .dup => double[d] = double[d - 1],
                .swap => std.mem.swap(bool, &double[d - 2], &double[d - 1]),
                .local_int, .locals => double[d] = doubleForm(bc.localOperator(i.op)) != .cmp,
                .add_store => double[d - 2] = true,
                .binary => double[d - 2] = doubleForm(i.op) != .cmp,
                .elem => double[if (i.op == .get_elem_locals) d else d - 2] = false,
                .prop => double[if (i.op == .get_prop_local) d else d - 1] = false,
                .local_prop => double[d] = false,
                .store => if (!double[d - 1] and used[i.a]) {
                    used[i.a] = false;
                    changed = true;
                },
                .none => switch (i.op) {
                    .new_object, .load_env, .load_env_checked => double[d] = false,
                    .set_prop => double[d - 2] = double[d - 1],
                    else => {},
                },
                .pop, .jump, .cond_jump => {},
            }
        }
    }
    var out: std.ArrayList(Carried) = .empty;
    for (used, 0..) |yes, local| if (yes and out.items.len < max_carried) {
        try out.append(alloc, .{ .local = @intCast(local), .v = f.newVReg() });
    };
    return out.items;
}

/// The loops of `insns` to lower with carried locals, none inside another.
fn carriedLoops(f: *ir.Func, t: *const bc.Template, insns: []const analyze.Insn, dead: []const bool) ![]Loop {
    var out: std.ArrayList(Loop) = .empty;
    // The first instruction of the loop taken last: an outer loop ends after its inner ones,
    // so walking backwards meets it first and its inner loops fall inside it.
    var lowest = insns.len;
    var k = insns.len;
    while (k > 0) {
        k -= 1;
        const j = insns[k];
        if (k >= lowest or (form(j.op) != .jump and form(j.op) != .cond_jump) or j.a > j.pc) continue;
        var head = k;
        while (head > 0 and insns[head].pc != j.a) head -= 1;
        if (insns[head].pc != j.a) continue;
        const region = insns[head .. k + 1];
        var sure = true;
        const whole = for (region) |i| {
            if (chained(t, i)) continue;
            if (!followed(i.op)) break false;
            sure = false;
        } else true;
        if (!whole or (!sure and !try takenWhole(f, t, insns, dead, head, k))) continue;
        const carried = try carriedIn(f, t, region);
        if (carried.len == 0) continue;
        try out.append(f.alloc(), .{ .from = j.a, .to = j.pc, .carried = carried });
        lowest = head;
    }
    return out.items;
}

/// A guard of the fast chain: the branch `op` of `block`, to be pointed at the generic code of
/// instruction `at`. The generic code reads the window and may look at a literal, so what the
/// chain had not stored when the guard was lowered is `owed`: a block of the guard's own
/// stores it before the generic code runs (`Lowerer.payOwed`), and the path that goes on
/// stores nothing for a guard that holds.
const Bail = struct { block: u32, op: usize, at: usize, owed: []const Owed = &.{} };

/// A store a failing guard makes on its way out: a window slot's value, or the shape word and
/// the empty slots of a literal.
const Owed = union(enum) {
    slot: struct { index: u32, k: Known },
    object: Object,
};

/// An instruction of a block: a constant the lowering changes after it was written.
const Spot = struct { block: u32, op: usize };

/// The literals of a stretch of the chain with no guard in it are taken from the run with one
/// move of its pointer and one guard, the first literal's: each later one adds its size to
/// what that move takes (`Lowerer.place`). A guard between two of them would leave the generic
/// code a run whose lowest block was never written, so the stretch ends at the first one.
const Fold = struct {
    /// The block the chain is in and the guards it has while the stretch lasts.
    cur: u32,
    bails: usize,
    /// Where the run's pointer was moved to.
    at: VReg,
    /// What the stretch has taken so far.
    bytes: u32,
};

/// The most one stretch takes from a run. No run is shorter than a line of the young region,
/// 512 bytes (jsrt_gc.zig), so a move of this size fits every fresh one.
const max_folded = 256;

/// A guard that would owe more stores than this has them made on the path that goes on,
/// once, rather than in a block of its own: the guards after it then owe nothing.
const max_owed = 16;

/// A constant of a loop with carried locals that takes more than one instruction to make
/// (`costly`). It is made where the loop is entered and kept in register `v` while the
/// loop's register copy runs, which calls nothing (`Lowerer.pooled`, `Lowerer.closeLoop`).
const Pooled = struct { bits: u64, float: bool, v: VReg };

/// Of each kind, integer and float: the registers are also the loop's own to compute with.
const max_pooled = 8;

/// Whether `bits` takes the backend more than one instruction: a value with one 16-bit part
/// that is not all zeros, or one that is not all ones, is a single move.
fn costly(bits: u64) bool {
    var set: u32 = 0;
    var clear: u32 = 0;
    for (0..4) |k| {
        const part: u16 = @truncate(bits >> @intCast(16 * k));
        if (part != 0) set += 1;
        if (part != 0xFFFF) clear += 1;
    }
    return set > 1 and clear > 1;
}

/// Where a guard of the fast chain goes when it fails. No block: `Lowerer.cbr` knows a guard
/// by it, and `Lowerer.generic` points each at the generic code of its instruction. The paths
/// the generic code calls a helper on take it for their slow block and so become guards.
const leave: u32 = std.math.maxInt(u32);

const Lowerer = struct {
    f: *ir.Func,
    t: *const bc.Template,
    ctx: VReg,
    w: VReg,
    argv: VReg,
    argc: VReg,
    cur: ?u32 = null,
    exit: u32,
    insns: []const analyze.Insn = &.{},
    /// Index in `insns` of the instruction being lowered.
    at: usize = 0,
    blocks: std.AutoHashMapUnmanaged(u32, u32) = .empty,
    /// By window index, for the block of the bytecode being lowered.
    known: std.AutoHashMapUnmanaged(u32, Known) = .empty,
    /// The literals of that block, which `Known.obj` names.
    objects: std.ArrayList(Object) = .empty,
    /// The code being written is a path `save` stored on: its guards and calls find the
    /// window whole though the chain's bookkeeping says otherwise.
    aside: bool = false,
    bails: std.ArrayList(Bail) = .empty,
    /// How many of `bails` have the blocks their stores are owed in (`payOwed`).
    paid: usize = 0,
    /// The fast chain lowered the next instruction with this one.
    fused: bool = false,
    loops: []const Loop = &.{},
    /// The loop whose register copy is being lowered.
    loop: ?*const Loop = null,
    /// By pc, the register entries of the blocks of `loops`; `blocks` holds their window entries.
    carried_blocks: std.AutoHashMapUnmanaged(u32, u32) = .empty,
    /// The blocks in the order they were first written to.
    order: std.ArrayList(u32) = .empty,
    /// The register copy of `loop` is being lowered, so a constant may be one of `pool`.
    pooling: bool = false,
    pool: std.ArrayList(Pooled) = .empty,
    /// The blocks that end the window entries of `loop`: each jumps to a register entry, and
    /// makes the constants of `pool` first.
    entries: std.ArrayList(u32) = .empty,
    /// By pc outside `loop`, the block its register copy leaves for it through.
    exits: std.AutoHashMapUnmanaged(u32, u32) = .empty,
    /// What is being written seldom runs (`seldom`), and the blocks of `loop` first written
    /// so: they are laid out after the loop's others (`closeLoop`).
    rare: bool = false,
    late: std.ArrayList(u32) = .empty,
    /// The stretch the last literal was allocated in, and the constants that grow with it:
    /// how far the run's pointer moves, and how far above it each of its literals is.
    fold: ?Fold = null,
    grows: std.ArrayList(Spot) = .empty,

    fn block(l: *Lowerer) !u32 {
        return l.f.addBlock("b");
    }

    fn blockAt(l: *Lowerer, pc: u32) !u32 {
        return l.blockIn(&l.blocks, pc);
    }

    /// The block `map` keeps for `pc`, made on its first mention.
    fn blockIn(l: *Lowerer, map: *std.AutoHashMapUnmanaged(u32, u32), pc: u32) !u32 {
        const gop = try map.getOrPut(l.f.alloc(), pc);
        if (!gop.found_existing) gop.value_ptr.* = try l.block();
        return gop.value_ptr.*;
    }

    fn emit(l: *Lowerer, o: ir.Op) !void {
        const b = l.cur.?;
        if (l.f.blocks.items[b].ops.items.len == 0) try (if (l.rare) &l.late else &l.order).append(l.f.alloc(), b);
        try l.f.emit(b, o);
    }

    /// The blocks written from here on are ones a turn of the loop seldom reaches, or no
    /// longer are. Laid out among the others they would be jumped over on every turn, and a
    /// loop of a few instructions is as slow as its taken jumps are many.
    fn seldom(l: *Lowerer, on: bool) void {
        l.rare = on and l.loop != null;
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
        if (try l.pooled(@bitCast(v), false)) |k| return k;
        return l.def(.@"const", .{ .dst = undefined, .imm = v });
    }

    /// The register that holds `bits` for the whole of the loop being lowered, when the
    /// constant is worth one.
    fn pooled(l: *Lowerer, bits: u64, float: bool) !?VReg {
        if (!l.pooling or !costly(bits)) return null;
        var kind: usize = 0;
        for (l.pool.items) |x| {
            if (x.float != float) continue;
            if (x.bits == bits) return x.v;
            kind += 1;
        }
        if (kind == max_pooled) return null;
        const v = l.f.newVReg();
        try l.pool.append(l.f.alloc(), .{ .bits = bits, .float = float, .v = v });
        return v;
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

    fn storeF(l: *Lowerer, index: u32, v: VReg) !void {
        try l.emit(.{ .store = .{ .base = l.w, .disp = disp(index), .src = v, .ty = .f64 } });
    }

    fn storeConst(l: *Lowerer, index: u32, v: u64) !void {
        try l.store(index, try l.konst(imm(v)));
    }

    fn arith(l: *Lowerer, o: ir.Arith, a: VReg, b: VReg) !VReg {
        return l.def(.arith, .{ .op = o, .dst = undefined, .a = a, .b = b });
    }

    fn cbr(l: *Lowerer, cond: ir.CondCode, a: VReg, b: VReg, then: u32, else_: u32) !void {
        // The instruction then runs from its start in the generic code, so every guard of an
        // instruction comes before the first value it puts.
        const owes: []const Owed = if (then == leave) try l.owed() else &.{};
        try l.emit(.{ .cbr = .{ .cond = cond, .a = a, .b = b, .then = then, .@"else" = else_ } });
        if (then == leave) {
            const from = l.cur.?;
            try l.bails.append(l.f.alloc(), .{ .block = from, .op = l.f.blocks.items[from].ops.items.len - 1, .at = l.at, .owed = owes });
        }
        l.cur = null;
    }

    fn br(l: *Lowerer, to: u32) !void {
        try l.emit(.{ .br = to });
        l.cur = null;
    }

    fn callHelper(l: *Lowerer, comptime f: anytype, args: []const VReg) !VReg {
        l.assertSaved();
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
        if (o == .mod) return l.remainder(s);
        const doubled = doubleForm(o);
        if (doubled == .none) return l.helper(h.binary, &.{ s, @backingInt(o) });

        const slow = try l.block();
        const join = try l.block();
        try l.guardDouble(try l.load(s), slow);
        try l.guardDouble(try l.load(s + 1), slow);
        const a = try l.loadF(s);
        const b = try l.loadF(s + 1);
        switch (doubled) {
            .none => unreachable,
            .arith => |ta| try l.typedF64(ta, a, b, s, join),
            .cmp => |cond| {
                try l.store(s, try l.boolean(try l.fcmp(cond, a, b)));
                try l.br(join);
            },
        }
        try l.slowPath(slow, join, h.binary, o, s);
    }

    /// The boxed boolean of a 0 or 1: JSRT_TRUE is JSRT_FALSE + 1.
    fn boolean(l: *Lowerer, bit: VReg) !VReg {
        return l.arith(.add, bit, try l.konst(imm(c.JSRT_FALSE)));
    }

    /// The integer case of vm.jsMod, expressed with the backend's existing conversions and
    /// signed remainder. Magnitudes below 2^53 exclude boxed values, NaN and infinities before
    /// conversion; the round trip rejects fractions. Both guards also exclude i64 overflow.
    fn exactInteger(l: *Lowerer, s: u32, slow: u32) !VReg {
        const bits = try l.load(s);
        const magnitude = try l.arith(.@"and", bits, try l.konst(0x7FFF_FFFF_FFFF_FFFF));
        const in_range = try l.block();
        try l.cbr(.uge, magnitude, try l.konst(@bitCast(integer_limit)), slow, in_range);
        l.cur = in_range;
        const integer, const exact = try l.truncated(try l.loadF(s));
        try l.guardEq(exact, 1, slow);
        return integer;
    }

    /// Double `value` as an integer, and whether it was one: 1 when converting back gives it.
    fn truncated(l: *Lowerer, value: VReg) !struct { VReg, VReg } {
        const integer = try l.def(.cvt, .{ .dst = undefined, .src = value, .from = .f64, .to = .i64 });
        const back = try l.def(.cvt, .{ .dst = undefined, .src = integer, .from = .i64, .to = .f64 });
        return .{ integer, try l.fcmp(.eq, value, back) };
    }

    fn fcmp(l: *Lowerer, cond: ir.FCond, a: VReg, b: VReg) !VReg {
        return l.def(.fcmp, .{ .dst = undefined, .cond = cond, .ty = .f64, .a = a, .b = b });
    }

    fn remainder(l: *Lowerer, s: u32) !void {
        const slow = try l.block();
        const join = try l.block();
        const a = try l.exactInteger(s, slow);
        const b = try l.exactInteger(s + 1, slow);
        const nonzero = try l.block();
        const zero = try l.konst(0);
        try l.cbr(.eq, b, zero, slow, nonzero);
        l.cur = nonzero;
        const r = try l.arith(.srem, a, b);
        const signed_zero = try l.block();
        const number = try l.block();
        try l.cbr(.eq, r, zero, signed_zero, number);
        l.cur = number;
        const value = try l.def(.cvt, .{ .dst = undefined, .src = r, .from = .i64, .to = .f64 });
        try l.storeF(s, value);
        try l.br(join);
        l.cur = signed_zero;
        // Integer conversion loses -0; JavaScript's zero remainder keeps the dividend's sign.
        try l.store(s, try l.arith(.@"and", try l.load(s), try l.konst(imm(0x8000_0000_0000_0000))));
        try l.br(join);
        try l.slowPath(slow, join, h.binary, .mod, s);
    }

    /// `a op b` in f64 into window slot `s`, then on to `join` with its NaN canonical.
    fn typedF64(l: *Lowerer, o: ir.TArith, a: VReg, b: VReg, s: u32, join: u32) !void {
        const d = try l.def(.typed, .{ .op = o, .ty = .f64, .dst = undefined, .a = a, .b = b });
        try l.storeF(s, d);
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

    /// The sign, exponent, quiet bit and tag of `v`, to compare with a `boxTag`.
    fn tagOf(l: *Lowerer, v: VReg) !VReg {
        return l.arith(.@"and", v, try l.konst(imm(tag_bits)));
    }

    /// The array `w[s]` and the address of its element `w[s + 1]`; on to `slow` unless that is an
    /// array and an index below its length (vm.zig `denseIndex`).
    fn element(l: *Lowerer, s: u32, slow: u32) !struct { VReg, VReg } {
        const p = try l.arrayPtr(try l.load(s), slow);
        return .{ p, try l.elementAt(p, try l.exactInteger(s + 1, slow), slow) };
    }

    /// The array pointer of `v` when it is an array, else on to `no`.
    fn arrayPtr(l: *Lowerer, v: VReg, no: u32) !VReg {
        try l.guardEq(try l.tagOf(v), boxTag(c.JSRT_TAG_ARRAY), no);
        return l.ptrOf(v);
    }

    /// The address of element `index` of array `p`; on to `no` unless it is below the length.
    fn elementAt(l: *Lowerer, p: VReg, index: VReg, no: u32) !VReg {
        const inside = try l.block();
        // A negative index is above every length when compared unsigned.
        try l.cbr(.uge, index, try l.arrayLength(p), no, inside);
        l.cur = inside;
        const elements = try l.def(.load, .{ .dst = undefined, .base = p, .disp = @offsetOf(c.JSRTArray, "elements") });
        return l.arith(.add, elements, try l.arith(.shl, index, try l.konst(3)));
    }

    fn arrayLength(l: *Lowerer, p: VReg) !VReg {
        // `length` is a u32 and the IR loads 64 bits: keep the low half.
        const raw = try l.def(.load, .{ .dst = undefined, .base = p, .disp = @offsetOf(c.JSRTArray, "length") });
        return l.arith(.@"and", raw, try l.konst(0xFFFF_FFFF));
    }

    /// `obj[key]` (obj key at `s` -> value at `s`): an array's element at an index below its
    /// length is loaded in place. A hole reads as undefined, which the helper answers.
    fn getElem(l: *Lowerer, s: u32) !void {
        const slow = try l.block();
        _, const at = try l.element(s, slow);
        const v = try l.def(.load, .{ .dst = undefined, .base = at, .disp = 0 });
        const present = try l.block();
        try l.cbr(.eq, v, try l.konst(imm(c.JSRT_HOLE)), slow, present);
        l.cur = present;
        try l.fastOrHelper(s, v, slow, h.getElem, &.{s});
    }

    /// `obj[key] = value` (obj key value at `s` -> value at `s`): an array's element at an index
    /// below its length is written in place, after the collector's write barrier on the array.
    fn setElem(l: *Lowerer, s: u32) !void {
        const slow = try l.block();
        const p, const at = try l.element(s, slow);
        try l.barrier(p);
        const v = try l.load(s + 2);
        try l.emit(.{ .store = .{ .base = at, .disp = 0, .src = v } });
        try l.fastOrHelper(s, v, slow, h.setElem, &.{s});
    }

    /// The inline-cache index of the `get_method` named `name` that read the callee of the call
    /// being lowered, whose callee is operand `base`: compile.zig's member call is `dup`,
    /// `get_method`, `swap`, the arguments, the call. Only a hint: `push` checks the callee.
    fn methodSite(l: *Lowerer, base: u32, name: []const u8) ?u32 {
        var k = l.at;
        while (k >= 2) : (k -= 1) {
            const x = l.insns[k - 1];
            if (x.depth < base + 2) return null;
            if (x.op != .swap or x.depth != base + 2) continue;
            const g = l.insns[k - 2];
            return if (g.op == .get_method and std.mem.eql(u8, std.mem.span(l.t.keys[g.a]), name)) g.b else null;
        }
        return null;
    }

    /// `a.push(v)` (method this value at `s` -> the new length at `s`). A callee that is the
    /// method site `ic` cached for this receiver is the runtime's own `push` bound to that
    /// array: the cache is filled only from an array without own properties (vm.getMethod).
    /// An array with room then takes the element in place, as `array_store` would.
    fn push(l: *Lowerer, s: u32, ic: u32) !void {
        comptime std.debug.assert(@offsetOf(c.JSRTArray, "capacity") == @offsetOf(c.JSRTArray, "length") + 4);
        comptime std.debug.assert(builtin.cpu.arch.endian() == .little);
        const slow = try l.block();
        const join = try l.block();
        const this = try l.load(s + 1);
        // An empty cache holds undefined twice, which a call of undefined would match.
        try l.guardEq(try l.tagOf(this), boxTag(c.JSRT_TAG_ARRAY), slow);
        const cache: u32 = @intCast(vm.methodCacheIndex(l.t, ic));
        const mine = try l.block();
        try l.cbr(.ne, this, try l.load(cache), slow, mine);
        l.cur = mine;
        const bound = try l.block();
        try l.cbr(.ne, try l.load(s), try l.load(cache + 1), slow, bound);
        l.cur = bound;
        const p = try l.ptrOf(this);
        // `length` and `capacity` are adjacent u32s, read and written as one word.
        const word = try l.def(.load, .{ .dst = undefined, .base = p, .disp = @offsetOf(c.JSRTArray, "length") });
        const len = try l.arith(.@"and", word, try l.konst(0xFFFF_FFFF));
        const room = try l.block();
        try l.cbr(.uge, len, try l.arith(.shr, word, try l.konst(32)), slow, room);
        l.cur = room;
        try l.barrier(p);
        const elements = try l.def(.load, .{ .dst = undefined, .base = p, .disp = @offsetOf(c.JSRTArray, "elements") });
        try l.emit(.{ .store = .{ .base = try l.arith(.add, elements, try l.arith(.shl, len, try l.konst(3))), .disp = 0, .src = try l.load(s + 2) } });
        // The length is below the capacity, so the sum does not carry into it.
        const one = try l.konst(1);
        try l.emit(.{ .store = .{ .base = p, .disp = @offsetOf(c.JSRTArray, "length"), .src = try l.arith(.add, word, one) } });
        const n = try l.def(.cvt, .{ .dst = undefined, .src = try l.arith(.add, len, one), .from = .i64, .to = .f64 });
        try l.storeF(s, n);
        try l.br(join);
        l.cur = slow;
        try l.helper(h.call, &.{ s, 1 });
        try l.br(join);
        l.cur = join;
    }

    /// The object pointer of `v` when it is a dynamic object, else on to `no`.
    fn dynObj(l: *Lowerer, v: VReg, no: u32) !VReg {
        try l.guardEq(try l.tagOf(v), boxTag(c.JSRT_TAG_OBJECT), no);
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
        try l.cbr(.eq, try l.tagOf(v), try l.konst(imm(boxTag(c.JSRT_TAG_OBJECT))), object, done);
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

    /// The collector's write barrier before a store into collected object `p`: nothing while the
    /// object is already dirty (packages/runtime/include/jsrt.h), else `jsrt_gc_write`.
    fn barrier(l: *Lowerer, p: VReg) !void {
        const mark = try l.block();
        const done = try l.block();
        const word = try l.def(.load, .{ .dst = undefined, .base = p, .disp = -c.JSRT_GC_HEADER_BYTES });
        const dirty = try l.arith(.@"and", word, try l.konst(imm(@as(u64, 1) << c.JSRT_GC_DIRTY_BIT)));
        try l.cbr(.eq, dirty, try l.konst(0), mark, done);
        l.cur = mark;
        _ = try l.callHelper(c.jsrt_gc_write, &.{p});
        try l.br(done);
        l.cur = done;
    }

    /// `define` (obj value at `s` -> obj at `s`) through the site's transition cache: a dynamic
    /// object on the shape the site last left, with room for the slot, takes the same step in
    /// place. An empty cache holds no shape, which no object is on.
    fn define(l: *Lowerer, i: analyze.Insn) !void {
        const s = l.slot(i.depth - 2);
        const slow = try l.block();
        const hit = try l.block();
        const room = try l.block();
        const join = try l.block();
        const site = try l.konst(@intCast(@intFromPtr(&l.t.transitions[i.b])));
        const p = try l.dynObj(try l.load(s), slow);
        const shape = try l.def(.load, .{ .dst = undefined, .base = p, .disp = @offsetOf(c.JSRTDynObject, "shape") });
        const from = try l.def(.load, .{ .dst = undefined, .base = site, .disp = @offsetOf(bc.Transition, "from") });
        try l.cbr(.ne, shape, from, slow, hit);
        l.cur = hit;
        // `offset` and `capacity` are u32s and the IR loads 64 bits: keep the low halves.
        const low = try l.konst(0xFFFF_FFFF);
        const off = try l.arith(.@"and", try l.def(.load, .{ .dst = undefined, .base = site, .disp = @offsetOf(bc.Transition, "offset") }), low);
        const capacity = try l.arith(.@"and", try l.def(.load, .{ .dst = undefined, .base = p, .disp = @offsetOf(c.JSRTDynObject, "capacity") }), low);
        try l.cbr(.uge, off, capacity, slow, room);
        l.cur = room;
        try l.barrier(p);
        const slots = try l.def(.load, .{ .dst = undefined, .base = p, .disp = @offsetOf(c.JSRTDynObject, "slots") });
        const at = try l.arith(.add, slots, try l.arith(.shl, off, try l.konst(3)));
        try l.emit(.{ .store = .{ .base = at, .disp = 0, .src = try l.load(s + 1) } });
        const to = try l.def(.load, .{ .dst = undefined, .base = site, .disp = @offsetOf(bc.Transition, "to") });
        try l.emit(.{ .store = .{ .base = p, .disp = @offsetOf(c.JSRTDynObject, "shape"), .src = to } });
        try l.br(join);
        l.cur = slow;
        try l.helper(h.define, &.{ s, i.a, i.b });
        try l.br(join);
        l.cur = join;
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
        try l.barrier(p);
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
    fn getProp(l: *Lowerer, s: u32, key: u32, ic: u32) !void {
        // `constructor` has answers of its own before any shape is asked (vm.getProp).
        const name = std.mem.span(l.t.keys[key]);
        if (std.mem.eql(u8, name, "constructor")) return l.helper(h.getProp, &.{ s, key, ic });
        if (!std.mem.eql(u8, name, "length")) return l.cachedProp(s, key, ic);
        // An array's length is a field of the array (vm.zig `knownProperty`).
        const join = try l.block();
        const v = try l.load(s);
        const other = try l.ifArray(v);
        const len = try l.def(.cvt, .{ .dst = undefined, .src = try l.arrayLength(try l.ptrOf(v)), .from = .i64, .to = .f64 });
        try l.storeF(s, len);
        try l.goOn(join, other);
        try l.cachedProp(s, key, ic);
        try l.goOn(join, join);
    }

    /// Goes on in a new block when `v` is an array; the block for anything else is the answer.
    fn ifArray(l: *Lowerer, v: VReg) !u32 {
        const array = try l.block();
        const other = try l.block();
        try l.cbr(.eq, try l.tagOf(v), try l.konst(imm(boxTag(c.JSRT_TAG_ARRAY))), array, other);
        l.cur = array;
        return other;
    }

    /// Ends the current block at `join` and goes on in `next`.
    fn goOn(l: *Lowerer, join: u32, next: u32) !void {
        try l.br(join);
        l.cur = next;
    }

    fn cachedProp(l: *Lowerer, s: u32, key: u32, ic: u32) !void {
        const slow = try l.block();
        const v = try l.cachedRead(try l.dynObj(try l.load(s), slow), &l.t.ics[ic], slow);
        try l.fastOrHelper(s, v, slow, h.getProp, &.{ s, key, ic });
    }

    /// `obj.key` about to be called. An array with no own properties answers the bound method
    /// this activation cached for it (vm.getMethod); the helper fills the cache on a miss.
    fn getMethod(l: *Lowerer, s: u32, key: u32, ic: u32) !void {
        const named = try l.block();
        const plain = try l.block();
        const hit = try l.block();
        const miss = try l.block();
        const join = try l.block();
        const v = try l.load(s);
        const other = try l.ifArray(v);
        const shape = try l.def(.load, .{ .dst = undefined, .base = try l.ptrOf(v), .disp = @offsetOf(c.JSRTArray, "shape") });
        try l.cbr(.eq, shape, try l.konst(0), plain, named);
        l.cur = named;
        try l.cbr(.eq, shape, try l.konst(@intCast(@intFromPtr(&c.jsrt_shape_root))), plain, miss);
        l.cur = plain;
        const cache: u32 = @intCast(vm.methodCacheIndex(l.t, ic));
        // The cached receiver starts as undefined, which is no array.
        try l.cbr(.eq, v, try l.load(cache), hit, miss);
        l.cur = hit;
        try l.store(s, try l.load(cache + 1));
        try l.goOn(join, miss);
        try l.helper(h.getMethod, &.{ s, key, ic });
        try l.goOn(join, other);
        try l.getProp(s, key, ic);
        try l.goOn(join, join);
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
        const on_true, const on_false = try l.branches(i);
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

    fn arg(l: *Lowerer, index: u32, to: u32) !void {
        const has = try l.block();
        const none = try l.block();
        const join = try l.block();
        try l.cbr(.ugt, l.argc, try l.konst(index), has, none);
        l.cur = has;
        try l.store(to, try l.def(.load, .{ .dst = undefined, .base = l.argv, .disp = @intCast(index * 8) }));
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

    fn knownAt(l: *Lowerer, index: u32) Known {
        return l.known.get(index) orelse .{};
    }

    fn know(l: *Lowerer, index: u32, k: Known) !void {
        try l.known.put(l.f.alloc(), index, k);
    }

    /// Leaves the fast chain when `a cond b`.
    fn bailIf(l: *Lowerer, cond: ir.CondCode, a: VReg, b: VReg) !void {
        const next = try l.block();
        try l.cbr(cond, a, b, leave, next);
        l.cur = next;
    }

    fn bitsOf(l: *Lowerer, index: u32, k: *Known) !VReg {
        if (k.bits) |bits| return bits;
        if (k.word) |word| return l.konst(imm(word));
        if (k.konst) |x| return l.konst(imm(rt.number(x)));
        // Only a float register has it, and its bits reach an integer one through memory.
        if (k.unsaved) {
            try l.storeF(index, k.f.?);
            k.unsaved = false;
        }
        k.bits = try l.load(index);
        return k.bits.?;
    }

    /// Stores what window slot `index` waits for.
    fn settleSlot(l: *Lowerer, index: u32, k: *Known) !void {
        try l.storeKnown(k, index, l.w, disp(index));
        k.unsaved = false;
    }

    fn fnum(l: *Lowerer, x: f64) !VReg {
        if (try l.pooled(rt.number(x), true)) |k| return k;
        return l.def(.fconst, .{ .dst = undefined, .ty = .f64, .bits = rt.number(x) });
    }

    /// Window slot `index` as a double in a float register; any other value leaves the chain.
    fn doubleOf(l: *Lowerer, index: u32) !VReg {
        var k = l.knownAt(index);
        if (!k.double) {
            const m = try l.konst(imm(mask));
            try l.bailIf(.eq, try l.arith(.@"and", try l.bitsOf(index, &k), m), m);
            k.double = true;
            k.live = true;
        }
        if (k.f == null) {
            if (k.konst) |x| {
                k.f = try l.fnum(x);
            } else {
                // An integer register has it, and its bits reach a float one through memory:
                // the slot they came from, or this one once it has them.
                const from = l.atHome(k) orelse index;
                if (from == index and k.unsaved) try l.settleSlot(index, &k);
                k.f = try l.loadF(from);
            }
        }
        try l.know(index, k);
        return k.f.?;
    }

    /// Window slot `index` is to hold what `k` describes. The store waits for `save`.
    fn put(l: *Lowerer, index: u32, k: Known) !void {
        std.debug.assert(k.held());
        var waiting = k;
        waiting.unsaved = true;
        try l.know(index, waiting);
    }

    fn putDouble(l: *Lowerer, index: u32, f: VReg) !void {
        try l.put(index, .{ .f = f, .double = true, .live = true });
    }

    /// What is known of window slot `index`, in a register if nothing else has its value.
    fn heldAt(l: *Lowerer, index: u32) !Known {
        var k = l.knownAt(index);
        if (!k.held()) {
            k.bits = try l.load(index);
            k.home = index;
            try l.know(index, k);
        }
        return k;
    }

    /// The window slot that holds the bits of `k`, when one does: the slot they were loaded
    /// from, unless something else has been put there since or is waiting to be.
    fn atHome(l: *Lowerer, k: Known) ?u32 {
        const home = k.home orelse return null;
        const there = l.knownAt(home);
        return if (there.bits == k.bits and !there.unsaved) home else null;
    }

    /// Stores at `base + at` the value `k` describes, which window slot `index` holds: the slot
    /// is read only when nothing else has the value.
    fn storeKnown(l: *Lowerer, k: *Known, index: u32, base: VReg, at: i32) !void {
        if (k.konst) |x| {
            try l.emit(.{ .store = .{ .base = base, .disp = at, .src = try l.konst(imm(rt.number(x))) } });
        } else if (k.bits == null and k.f != null) {
            try l.emit(.{ .store = .{ .base = base, .disp = at, .src = k.f.?, .ty = .f64 } });
        } else try l.emit(.{ .store = .{ .base = base, .disp = at, .src = try l.bitsOf(index, k) } });
    }

    /// Copies window slot `from` into slot `to`, with what is known of its value.
    fn copySlot(l: *Lowerer, from: u32, to: u32) !void {
        try l.put(to, try l.heldAt(from));
    }

    /// Where another block may arrive, or after an instruction without a form: it may have
    /// called anything.
    fn forget(l: *Lowerer) void {
        l.known.clearRetainingCapacity();
        l.objects.clearRetainingCapacity();
    }

    /// Before a call or the end of the block: whoever runs next reads the window and may look
    /// at a literal, so each slot is given the value it waits for and each literal the shape
    /// it has reached. A guard needs none of it: what it owes is stored where it fails.
    fn flush(l: *Lowerer) !void {
        try l.save(false, l.popped());
    }

    /// `save` before a jump out of the block. The carried locals of a loop are not stored:
    /// the next block of the loop reads them from their registers, and the way out of the
    /// loop stores them (`edge`).
    fn saveEdge(l: *Lowerer, above: u32) !void {
        try l.saveBut(false, above, if (l.loop) |loop| loop.carried else &.{});
    }

    fn save(l: *Lowerer, aside: bool, above: u32) !void {
        try l.saveBut(aside, above, &.{});
    }

    /// The first window slot nothing reads: the operands from the instruction's depth up were
    /// popped.
    fn popped(l: *Lowerer) u32 {
        return l.slot(l.insns[l.at].depth);
    }

    /// Gives literal `o` the shape it has reached and clears the slots no member has filled.
    fn makeWhole(l: *Lowerer, o: Object) !void {
        if (!o.stored) try l.emit(.{ .store = .{ .base = o.p, .disp = @offsetOf(c.JSRTDynObject, "shape"), .src = try l.konst(@intCast(@intFromPtr(o.shape))) } });
        for (0..o.capacity) |k| {
            if (!o.filled.isSet(k)) try l.emit(.{ .store = .{ .base = o.p, .disp = ownSlot(@intCast(k)), .src = try l.konst(0) } });
        }
    }

    /// `flush` of the slots below `above`, or with `aside` the same stores on a path that
    /// seldom runs and joins the chain again: there the chain goes on as if nothing were
    /// stored, since its other path stored nothing. The locals of `waiting` are left out.
    fn saveBut(l: *Lowerer, aside: bool, above: u32, waiting: []const Carried) !void {
        for (l.objects.items) |*o| {
            if (o.whole()) continue;
            try l.makeWhole(o.*);
            if (aside) continue;
            o.stored = true;
            o.filled = .full;
        }
        var it = l.known.iterator();
        while (it.next()) |e| {
            const k = e.value_ptr;
            if (!k.unsaved or e.key_ptr.* >= above) continue;
            const waits = for (waiting) |x| {
                if (vm.header + x.local == e.key_ptr.*) break true;
            } else false;
            if (waits) continue;
            try l.storeKnown(k, e.key_ptr.*, l.w, disp(e.key_ptr.*));
            if (!aside) k.unsaved = false;
        }
        l.aside = aside;
    }

    /// What a guard lowered here owes (`Bail`).
    fn owed(l: *Lowerer) ![]const Owed {
        if (l.aside) return &.{};
        const alloc = l.f.alloc();
        var out: std.ArrayList(Owed) = .empty;
        var stores: usize = 0;
        for (l.objects.items) |o| {
            if (o.whole()) continue;
            try out.append(alloc, .{ .object = o });
            stores += @intFromBool(!o.stored) + o.capacity - o.filled.count();
        }
        var it = l.known.iterator();
        while (it.next()) |e| {
            if (!e.value_ptr.unsaved or e.key_ptr.* >= l.popped()) continue;
            try out.append(alloc, .{ .slot = .{ .index = e.key_ptr.*, .k = e.value_ptr.* } });
            stores += 1;
        }
        if (stores <= max_owed) return out.items;
        try l.flush();
        return &.{};
    }

    /// Ends a run of the chain: each guard since the last that owes stores gets the block that
    /// makes them. The blocks come after the run's own, so the path that goes on passes none,
    /// and no later than that, so a value they store is kept in a register no longer.
    fn payOwed(l: *Lowerer) !void {
        const was = l.cur;
        for (l.bails.items[l.paid..]) |*b| {
            if (b.owed.len == 0) continue;
            const side = try l.block();
            l.f.blocks.items[b.block].ops.items[b.op].cbr.then = side;
            l.cur = side;
            for (b.owed) |x| switch (x) {
                .slot => |at| {
                    var k = at.k;
                    try l.storeKnown(&k, at.index, l.w, disp(at.index));
                },
                .object => |o| try l.makeWhole(o),
            };
            try l.emit(.{ .br = leave });
            b.* = .{ .block = side, .op = l.f.blocks.items[side].ops.items.len - 1, .at = b.at };
        }
        l.paid = l.bails.items.len;
        l.cur = was;
    }

    /// A call finds the window and the literals as the collector expects them.
    fn assertSaved(l: *Lowerer) void {
        if (!std.debug.runtime_safety or l.aside) return;
        for (l.objects.items) |o| std.debug.assert(o.whole());
        var it = l.known.iterator();
        while (it.next()) |e| std.debug.assert(!e.value_ptr.unsaved or e.key_ptr.* >= l.popped());
    }

    /// The literal window slot `index` holds, when the chain made it.
    fn objectAt(l: *Lowerer, index: u32) ?*Object {
        return if (l.knownAt(index).obj) |n| &l.objects.items[n] else null;
    }

    /// Stores window slot `from` into slot `off` of `o`.
    fn setField(l: *Lowerer, o: *Object, off: u32, from: u32) !void {
        var k = l.knownAt(from);
        try l.storeKnown(&k, from, o.p, ownSlot(off));
        try l.know(from, k);
        o.filled.set(off);
        o.fields[off] = k;
        o.fields[off].unsaved = false;
    }

    /// A dynamic object with `n` slots of its own: its address and the boxed value. The block
    /// is taken from the open run of the collector's young region by moving the run's pointer
    /// down, and its prefix and the object are written here: the collector finds the block by
    /// its prefix when something asks about it (jsrt_mem.h, JSRTYoungSite; jsrt_alloc.zig,
    /// dynobjNew). A run without room -- none is open, or another thread may allocate -- leaves
    /// the chain for the allocator, which may collect: a literal calls nothing here, so no
    /// register of the chain is live across a call for it.
    fn newObject(l: *Lowerer, site: c.JSRTYoungSite, n: u32) !struct { VReg, VReg } {
        const p = try l.place(site);
        try l.emit(.{ .store = .{ .base = p, .disp = -c.JSRT_GC_HEADER_BYTES, .src = try l.konst(imm(site.word)) } });
        try l.emit(.{ .store = .{ .base = p, .disp = 8 - c.JSRT_GC_HEADER_BYTES, .src = try l.konst(imm(site.meta)) } });
        // Every word of the object but its shape and its slots, which `flush` stores
        // where a member has not: the run is not zeroed, and each field fills its word.
        const own = try l.arith(.add, p, try l.konst(@sizeOf(c.JSRTDynObject)));
        const fields = [_][]const u8{ "cls", "capacity", "slots" };
        const words = [fields.len]VReg{ try l.konst(@intCast(@intFromPtr(&c.jsrt_class_dynamic))), try l.konst(n), own };
        inline for (fields, 0..) |field, k| try l.emit(.{ .store = .{ .base = p, .disp = @offsetOf(c.JSRTDynObject, field), .src = words[k] } });
        // Two words that are both empty take one store between them.
        const zero = try l.konst(0);
        comptime std.debug.assert(@offsetOf(c.JSRTDynObject, "proto") == @offsetOf(c.JSRTDynObject, "frozen") + 8);
        comptime std.debug.assert(@sizeOf(c.JSRTDynObject) == (fields.len + 4) * 8);
        try l.emit(.{ .store = .{ .base = p, .disp = @offsetOf(c.JSRTDynObject, "frozen"), .src = try l.def(.splat, .{ .ty = .v2i64, .dst = undefined, .src = zero }), .ty = .v2i64 } });
        try l.emit(.{ .store = .{ .base = p, .disp = @offsetOf(c.JSRTDynObject, "ctor"), .src = zero } });
        return .{ p, try l.arith(.@"or", p, try l.konst(imm(boxTag(c.JSRT_TAG_OBJECT)))) };
    }

    /// The address of an object in a block of `site` taken from the open run, whose prefix is
    /// below it. The run is taken from its top down, and nothing fits a run that is not open.
    fn place(l: *Lowerer, site: c.JSRTYoungSite) !VReg {
        const fold = if (l.fold) |*x| x else return l.placeFirst(site);
        if (fold.cur != l.cur.? or fold.bails != l.bails.items.len or fold.bytes + site.total > max_folded) return l.placeFirst(site);
        fold.bytes += site.total;
        for (l.grows.items) |x| l.f.blocks.items[x.block].ops.items[x.op].@"const".imm += site.total;
        return l.lowest(fold.at);
    }

    /// `place` with a move of the run's pointer and a guard of its own, which starts a stretch.
    fn placeFirst(l: *Lowerer, site: c.JSRTYoungSite) !VReg {
        const run = try l.konst(@intCast(@intFromPtr(site.run)));
        const top = try l.def(.load, .{ .dst = undefined, .base = run, .disp = @offsetOf(c.JSRTYoungRun, "bump") });
        l.grows.clearRetainingCapacity();
        const at = try l.arith(.sub, top, try l.growing(site.total));
        try l.bailIf(.ult, at, try l.def(.load, .{ .dst = undefined, .base = run, .disp = @offsetOf(c.JSRTYoungRun, "limit") }));
        try l.emit(.{ .store = .{ .base = run, .disp = @offsetOf(c.JSRTYoungRun, "bump"), .src = at } });
        l.fold = .{ .cur = l.cur.?, .bails = l.bails.items.len, .at = at, .bytes = site.total };
        return l.lowest(at);
    }

    /// The object of the block at `at`, the lowest of its stretch so far.
    fn lowest(l: *Lowerer, at: VReg) !VReg {
        return l.arith(.add, at, try l.growing(c.JSRT_GC_HEADER_BYTES));
    }

    /// Constant `v`, which grows by the size of each literal the stretch takes after it. No
    /// other instruction reads its register.
    fn growing(l: *Lowerer, v: i64) !VReg {
        try l.grows.append(l.f.alloc(), .{ .block = l.cur.?, .op = l.f.blocks.items[l.cur.?].ops.items.len });
        return l.def(.@"const", .{ .dst = undefined, .imm = v });
    }

    /// The environment `hops` out from the frame's own (vm.outward).
    fn envOut(l: *Lowerer, hops: u32) !VReg {
        const frame = try l.def(.load, .{ .dst = undefined, .base = l.ctx, .disp = @offsetOf(h.Ctx, "frame") });
        var env = try l.def(.load, .{ .dst = undefined, .base = frame, .disp = @offsetOf(c.JSRTFrame, "env") });
        for (0..hops) |_| env = try l.def(.load, .{ .dst = undefined, .base = env, .disp = @offsetOf(c.JSRTEnv, "parent") });
        return env;
    }

    /// The forms of the instructions that make, fill and read an object literal (`Object`), and
    /// of the reads and writes of a captured variable, which reach no object.
    fn literal(l: *Lowerer, i: analyze.Insn) !bool {
        const d = i.depth;
        switch (i.op) {
            .new_object => {
                if (i.a == 0 or i.a > max_fields) return false;
                var site: c.JSRTYoungSite = undefined;
                // Where there is no region to take the block from, the allocator is called,
                // and a call is the generic code's.
                if (!c.jsrt_dynobj_young_site(i.a, &site)) return false;
                const p, const v = try l.newObject(site, i.a);
                try l.put(l.slot(d), .{ .live = true, .bits = v, .obj = @intCast(l.objects.items.len) });
                try l.objects.append(l.f.alloc(), .{ .p = p, .shape = &c.jsrt_shape_root, .capacity = i.a });
            },
            .define, .set_prop => {
                const s = l.slot(d - 2);
                const o = l.objectAt(s) orelse return false;
                const key = l.t.keys[i.a];
                if (!plainKey(key)) return false;
                if (c.jsrt_shape_find(o.shape, key)) |own| {
                    // A key the literal names twice keeps its slot (vm.defineAt), and so does
                    // one that is written.
                    try l.setField(o, own.*.offset, s + 1);
                } else {
                    // A write of a key the object lacks asks its prototypes for a setter first.
                    if (i.op == .set_prop) return false;
                    // The step the shape table would take when the instruction runs, taken now.
                    const to: *c.JSRTShape = c.jsrt_shape_transition(o.shape, key);
                    if (to.offset >= o.capacity) return false;
                    try l.setField(o, to.offset, s + 1);
                    o.shape = to;
                    o.stored = false;
                }
                // An assignment's value is what was assigned.
                if (i.op == .set_prop) try l.copySlot(s + 1, s);
            },
            .get_prop, .get_prop_local => {
                const local = i.op == .get_prop_local;
                const from = if (local) vm.header + i.a else l.slot(d - 1);
                const o = l.objectAt(from) orelse return false;
                const key = l.t.keys[if (local) i.c else i.a];
                if (!plainKey(key)) return false;
                // A key the object lacks is its prototype's to answer.
                const own = c.jsrt_shape_find(o.shape, key) orelse return false;
                const s = if (local) l.slot(d) else from;
                try l.put(s, o.fields[own.*.offset]);
            },
            // An environment is always dirty to the collector (jsrt_alloc.zig, env_kind), so
            // a store into one has no barrier to check. A variable still in its TDZ leaves the
            // chain for the helper, which throws.
            .store_env, .store_env_checked => {
                const s = l.slot(d - 1);
                const env = try l.envOut(i.a);
                if (i.op == .store_env_checked) try l.bailIf(.eq, try l.def(.load, .{ .dst = undefined, .base = env, .disp = envSlot(i.b) }), try l.konst(imm(rt.uninitialized)));
                var k = l.knownAt(s);
                try l.storeKnown(&k, s, env, envSlot(i.b));
                try l.know(s, k);
            },
            .load_env, .load_env_checked => {
                const v = try l.def(.load, .{ .dst = undefined, .base = try l.envOut(i.a), .disp = envSlot(i.b) });
                if (i.op == .load_env_checked) try l.bailIf(.eq, v, try l.konst(imm(rt.uninitialized)));
                try l.put(l.slot(d), .{ .bits = v });
            },
            else => return false,
        }
        return true;
    }

    /// The address of the dynamic object or of the array that window slot `index` holds; any
    /// other value leaves the chain.
    fn heapOf(l: *Lowerer, index: u32, comptime kind: enum { dyn, array }) !VReg {
        var k = l.knownAt(index);
        if (@field(k, @tagName(kind))) |p| return p;
        const v = try l.bitsOf(index, &k);
        const p = if (kind == .dyn) try l.dynObj(v, leave) else try l.arrayPtr(v, leave);
        @field(k, @tagName(kind)) = p;
        k.live = true;
        try l.know(index, k);
        return p;
    }

    /// What is known of the value at `at`, read into a register of each kind: a double is
    /// computed with in a float one, which the bits of an integer one reach only through
    /// memory.
    fn valueAt(l: *Lowerer, at: VReg) !Known {
        return .{
            .bits = try l.def(.load, .{ .dst = undefined, .base = at, .disp = 0 }),
            .f = try l.def(.load, .{ .dst = undefined, .base = at, .disp = 0, .ty = .f64 }),
            .live = true,
        };
    }

    /// Window slot `index` as the integer it is, for an index that is next compared with a
    /// length. A double outside i64 converts to the nearest end of it (AArch64, which the
    /// chain is for), and that is no index of any array: the comparison is the range's guard.
    fn indexOf(l: *Lowerer, index: u32) !VReg {
        const f = try l.doubleOf(index);
        if (l.knownAt(index).konst) |x| if (x >= 0 and x <= std.math.maxInt(u32) and @trunc(x) == x) return l.konst(@intFromFloat(x));
        const integer, const exact = try l.truncated(f);
        try l.bailIf(.eq, exact, try l.konst(0));
        return integer;
    }

    /// `obj.key` (window slot `from` -> slot `to`) as `cachedProp` reads it, with its helper's
    /// paths as guards: the generic code they leave for fills the site's cache.
    fn cachedField(l: *Lowerer, from: u32, ic: u32, to: u32) !void {
        const k = try l.valueAt(try l.cachedSlot(try l.heapOf(from, .dyn), &l.t.ics[ic], leave));
        try l.unlessAccessor(k.bits.?, leave);
        try l.put(to, k);
    }

    /// `array[index]` (window slots `from` and `index` -> slot `to`) as `getElem` reads it,
    /// with its helper's paths as guards.
    fn elementOf(l: *Lowerer, from: u32, index: u32, to: u32) !void {
        const p = try l.heapOf(from, .array);
        const k = try l.valueAt(try l.elementAt(p, try l.indexOf(index), leave));
        try l.bailIf(.eq, k.bits.?, try l.konst(imm(c.JSRT_HOLE)));
        try l.put(to, k);
    }

    /// Leaves the fast chain when local `local` is still in its TDZ: the generic code throws.
    fn liveLocal(l: *Lowerer, local: u32) !void {
        const index = vm.header + local;
        var k = l.knownAt(index);
        if (k.live) return;
        try l.bailIf(.eq, try l.bitsOf(index, &k), try l.konst(imm(rt.uninitialized)));
        k.live = true;
        try l.know(index, k);
    }

    /// The integer that double `f` is, as vm.jsMod's integer case wants it: a fraction, a NaN,
    /// an infinity or a magnitude from 2^53 leaves the chain. `k` is `f` when the bytecode
    /// names it.
    fn integerOf(l: *Lowerer, f: VReg, k: ?f64) !VReg {
        if (k) |x| if (@abs(x) < integer_limit and @trunc(x) == x) return l.konst(@intFromFloat(x));
        const zero = try l.konst(0);
        try l.bailIf(.eq, try l.fcmp(.lt, f, try l.fnum(integer_limit)), zero);
        try l.bailIf(.eq, try l.fcmp(.gt, f, try l.fnum(-integer_limit)), zero);
        const integer, const exact = try l.truncated(f);
        try l.bailIf(.eq, exact, zero);
        return integer;
    }

    /// The block a jump to `pc` goes to: from the register copy of a loop to a block of the
    /// same loop, that block's register entry.
    fn edge(l: *Lowerer, pc: u32) !u32 {
        const loop = l.loop orelse return l.blockAt(pc);
        if (loop.holds(pc)) return l.blockIn(&l.carried_blocks, pc);
        // The way out stores the carried locals (`closeLoop`), which the window lacks.
        return l.blockIn(&l.exits, pc);
    }

    /// After the last block of `loop`: what could not be written until all of the loop was
    /// lowered. Each window entry makes the constants the register copy took registers for,
    /// and each way out stores the carried locals, which no jump inside the loop does.
    fn closeLoop(l: *Lowerer) !void {
        const loop = l.loop orelse return;
        l.pooling = false;
        try l.order.appendSlice(l.f.alloc(), l.late.items);
        l.late.clearRetainingCapacity();
        const was = l.cur;
        for (l.entries.items) |b| {
            const ops = &l.f.blocks.items[b].ops;
            // Before the jump to the register entry, which ends the block.
            const at = ops.items.len - 1;
            for (l.pool.items) |x| try ops.insert(l.f.alloc(), at, if (x.float) .{ .fconst = .{ .dst = x.v, .ty = .f64, .bits = x.bits } } else .{ .@"const" = .{ .dst = x.v, .imm = @bitCast(x.bits) } });
        }
        var it = l.exits.iterator();
        while (it.next()) |e| {
            l.cur = e.value_ptr.*;
            for (loop.carried) |x| try l.storeF(vm.header + x.local, x.v);
            try l.br(try l.blockAt(e.key_ptr.*));
        }
        l.entries.clearRetainingCapacity();
        l.pool.clearRetainingCapacity();
        l.exits.clearRetainingCapacity();
        l.cur = was;
    }

    /// Where conditional jump `j` goes on true and on false.
    fn branches(l: *Lowerer, j: analyze.Insn) !struct { u32, u32 } {
        const target = try l.edge(j.a);
        const fall = try l.edge(j.next);
        return if (j.op == .jump_if_true) .{ target, fall } else .{ fall, target };
    }

    /// Before the register copy of a loop leaves a block: each carried local's value goes
    /// into its register, which the next block reads it from.
    fn carry(l: *Lowerer) !void {
        const loop = l.loop orelse return;
        var from: [max_carried]VReg = undefined;
        for (loop.carried, 0..) |x, k| {
            const f = try l.doubleOf(vm.header + x.local);
            // The register of another local is written below: read it first.
            from[k] = if (f != x.v and loop.carries(f)) try l.def(.copy, .{ .dst = undefined, .src = f }) else f;
        }
        for (loop.carried, from[0..loop.carried.len]) |x, f| {
            if (f != x.v) try l.emit(.{ .copy = .{ .dst = x.v, .src = f } });
        }
    }

    /// Starts the block of the bytecode at `i`. In a loop with carried locals that block is
    /// its window entry, where the generic code and jumps from outside arrive: it guards and
    /// loads the carried locals and goes on in the register entry.
    fn leader(l: *Lowerer, i: analyze.Insn) !void {
        if (l.cur != null) {
            const to = try l.edge(i.pc);
            try l.saveEdge(l.popped());
            try l.carry();
            try l.br(to);
        }
        try l.payOwed();
        const next: ?*const Loop = for (l.loops) |*x| {
            if (x.holds(i.pc)) break x;
        } else null;
        if (next != l.loop) try l.closeLoop();
        l.pooling = false;
        l.cur = try l.blockAt(i.pc);
        l.forget();
        l.loop = next;
        const loop = l.loop orelse return;
        l.seldom(true);
        for (loop.carried) |x| try l.emit(.{ .copy = .{ .dst = x.v, .src = try l.doubleOf(vm.header + x.local) } });
        try l.entries.append(l.f.alloc(), l.cur.?);
        try l.br(try l.edge(i.pc));
        l.seldom(false);
        l.cur = l.carried_blocks.get(i.pc).?;
        l.forget();
        l.pooling = true;
        // The window may hold an older value: a jump inside the loop stores none (`saveEdge`).
        for (loop.carried) |x| try l.know(vm.header + x.local, .{ .f = x.v, .double = true, .live = true, .unsaved = true });
    }

    /// Goes on when `a cond b` and to `otherwise` when not, which a NaN makes it.
    fn goOnIf(l: *Lowerer, cond: ir.FCond, a: VReg, b: VReg, otherwise: u32) !void {
        const next = try l.block();
        try l.cbr(.ne, try l.fcmp(cond, a, b), try l.konst(0), next, otherwise);
        l.cur = next;
    }

    /// Ends one arm of a choice of values: `r` is `v`, and on to `join`.
    fn settle(l: *Lowerer, r: VReg, v: VReg, join: u32) !void {
        try l.emit(.{ .copy = .{ .dst = r, .src = v } });
        try l.br(join);
    }

    /// `a op b` on two doubles into window slot `s`; `kb` is `b` when the bytecode names it.
    /// A comparison the next instruction jumps on becomes the jump.
    fn fastBinary(l: *Lowerer, o: Op, a: VReg, b: VReg, kb: ?f64, s: u32) !void {
        const zero = try l.konst(0);
        switch (doubleForm(o)) {
            .arith => |ta| try l.putDouble(s, try l.def(.typed, .{ .op = ta, .ty = .f64, .dst = undefined, .a = a, .b = b })),
            .cmp => |cond| {
                const bit = try l.fcmp(cond, a, b);
                const j = l.insns[l.at + 1];
                if (form(j.op) == .cond_jump and !j.leader and l.slot(j.depth - 1) == s) {
                    const on_true, const on_false = try l.branches(j);
                    // The jump pops what was compared.
                    try l.saveEdge(s);
                    try l.carry();
                    try l.cbr(.ne, bit, zero, on_true, on_false);
                    l.fused = true;
                    return;
                }
                try l.put(s, .{ .bits = try l.boolean(bit), .live = true });
            },
            .none => {
                std.debug.assert(o == .mod);
                // The wrap of an index or of a running sum seldom has anything to divide: a
                // dividend from zero up to the divisor is its own remainder, and one below twice
                // the divisor leaves their difference, which is exact (Sterbenz). A NaN fails
                // every comparison here and so reaches the division's guards.
                const r = l.f.newVReg();
                const join = try l.block();
                const divide = try l.block();
                const above = try l.block();
                try l.goOnIf(.ge, a, try l.fnum(0), divide);
                try l.goOnIf(.lt, a, b, above);
                try l.settle(r, a, join);
                l.seldom(true);
                l.cur = above;
                const less = try l.def(.typed, .{ .op = .sub, .ty = .f64, .dst = undefined, .a = a, .b = b });
                try l.goOnIf(.lt, less, b, divide);
                try l.settle(r, less, join);
                l.cur = divide;
                try l.save(true, l.popped());
                const n = try l.integerOf(a, null);
                const m = try l.integerOf(b, kb);
                if (kb == null or kb.? == 0) try l.bailIf(.eq, m, zero);
                const rem = try l.arith(.srem, n, m);
                const some = try l.block();
                const none = try l.block();
                try l.cbr(.ne, rem, zero, some, none);
                l.cur = none;
                // A zero remainder has the dividend's sign, and no integer is -0.
                try l.bailIf(.le, n, zero);
                try l.br(some);
                l.cur = some;
                try l.emit(.{ .cvt = .{ .dst = r, .src = rem, .from = .i64, .to = .f64 } });
                try l.br(join);
                l.seldom(false);
                l.cur = join;
                l.aside = false;
                try l.putDouble(s, r);
            },
        }
    }

    /// Lowers `i` on the fast chain (docs/ENGINE.md §3): what this block of the bytecode has
    /// loaded or computed stays in registers and reaches the window when a guard, a call or
    /// the block's end is next (`flush`), and a value the fast form cannot take leaves for the
    /// generic code (`bailIf`). Answers false for an instruction with no fast form.
    fn fast(l: *Lowerer, i: analyze.Insn) !bool {
        const d = i.depth;
        switch (form(i.op)) {
            .none => return l.literal(i),
            .literal => try l.put(l.slot(d), .{ .live = i.op != .uninit, .word = literalBits(i.op) }),
            .number => {
                const x: f64 = if (i.op == .int) @floatFromInt(@as(i32, @bitCast(i.a))) else l.t.numbers[i.a];
                try l.put(l.slot(d), .{ .double = true, .live = true, .konst = x });
            },
            .pop => {},
            .swap => {
                const a = try l.heldAt(l.slot(d - 2));
                try l.put(l.slot(d - 2), try l.heldAt(l.slot(d - 1)));
                try l.put(l.slot(d - 1), a);
            },
            .dup => try l.copySlot(l.slot(d - 1), l.slot(d)),
            // The window opens with the callee, `this` and `new.target`.
            .frame => try l.copySlot(switch (i.op) {
                .callee => 0,
                .this_raw => 1,
                else => 2,
            }, l.slot(d)),
            .load => {
                if (i.op == .load_checked) try l.liveLocal(i.a);
                try l.copySlot(vm.header + i.a, l.slot(d));
            },
            .store => {
                if (i.op == .store_checked) try l.liveLocal(i.a);
                try l.copySlot(l.slot(d - 1), vm.header + i.a);
            },
            .step => {
                const x = try l.doubleOf(vm.header + i.a);
                const ta: ir.TArith = if (i.op == .inc_local) .add else .sub;
                const r = try l.def(.typed, .{ .op = ta, .ty = .f64, .dst = undefined, .a = x, .b = try l.fnum(1) });
                try l.putDouble(l.slot(d), r);
                try l.putDouble(vm.header + i.a, r);
            },
            .local_int => {
                const k: f64 = @floatFromInt(@as(i32, @bitCast(i.c)));
                const a = try l.doubleOf(vm.header + i.a);
                try l.fastBinary(bc.localOperator(i.op), a, try l.fnum(k), k, l.slot(d));
            },
            .locals => {
                const a = try l.doubleOf(vm.header + i.a);
                const b = try l.doubleOf(vm.header + i.c);
                try l.fastBinary(bc.localOperator(i.op), a, b, null, l.slot(d));
            },
            .add_store, .binary => {
                const s = l.slot(d - 2);
                const a = try l.doubleOf(s);
                const b = try l.doubleOf(s + 1);
                // `add_store_local` is an addition whose sum also goes into a local.
                const stores = i.op == .add_store_local;
                if (stores) try l.liveLocal(i.a);
                try l.fastBinary(if (stores) .add else i.op, a, b, l.knownAt(s + 1).konst, s);
                if (stores) try l.copySlot(s, vm.header + i.a);
            },
            .prop => {
                const local = i.op == .get_prop_local;
                const from = if (local) vm.header + i.a else l.slot(d - 1);
                if (l.objectAt(from) != null) return l.literal(i);
                if (!chained(l.t, i)) return false;
                try l.cachedField(from, if (local) i.d else i.b, if (local) l.slot(d) else from);
            },
            .elem => if (i.op == .get_elem_locals) {
                try l.elementOf(vm.header + i.a, vm.header + i.c, l.slot(d));
            } else try l.elementOf(l.slot(d - 2), l.slot(d - 1), l.slot(d - 2)),
            // `i < array.length`: an array's length is a field of the array (`getProp`).
            .local_prop => {
                if (!chained(l.t, i)) return false;
                const a = try l.doubleOf(vm.header + i.a);
                const len = try l.arrayLength(try l.heapOf(vm.header + i.c, .array));
                const b = try l.def(.cvt, .{ .dst = undefined, .src = len, .from = .i64, .to = .f64 });
                try l.fastBinary(bc.localOperator(i.op), a, b, null, l.slot(d));
            },
            // Outside a loop with carried locals a jump has nothing to carry: the generic one.
            .jump => {
                if (l.loop == null) return false;
                const to = try l.edge(i.a);
                try l.saveEdge(l.popped());
                try l.carry();
                try l.br(to);
            },
            .cond_jump => {
                if (l.loop == null) return false;
                const s = l.slot(d - 1);
                var k = l.knownAt(s);
                const v = try l.bitsOf(s, &k);
                // Anything but a boolean is the generic code's to judge: it may call.
                try l.bailIf(.ugt, try l.arith(.sub, v, try l.konst(imm(c.JSRT_FALSE))), try l.konst(1));
                const on_true, const on_false = try l.branches(i);
                try l.saveEdge(s);
                try l.carry();
                try l.cbr(.eq, v, try l.konst(imm(c.JSRT_TRUE)), on_true, on_false);
            },
        }
        return true;
    }

    /// The generic code the fast chain's guards leave for: from the first guarded instruction
    /// of a block of the bytecode to the block's end. It comes after all the fast code, so no
    /// register of the fast chain is live across a helper call made here.
    fn generic(l: *Lowerer, dead: []const bool) !void {
        l.loop = null;
        l.forget();
        const bails = l.bails.items;
        var next: usize = 0;
        while (next < bails.len) {
            var at = bails[next].at;
            l.cur = null;
            while (true) : (at += 1) {
                if (l.cur == null or (next < bails.len and bails[next].at == at)) {
                    const b = try l.block();
                    if (l.cur != null) try l.br(b);
                    l.cur = b;
                    while (next < bails.len and bails[next].at == at) : (next += 1) {
                        switch (l.f.blocks.items[bails[next].block].ops.items[bails[next].op]) {
                            .cbr => |*guard| guard.then = b,
                            .br => |*to| to.* = b,
                            else => unreachable,
                        }
                    }
                }
                l.at = at;
                if (!dead[at]) try l.insn(l.insns[at]);
                if (at + 1 == l.insns.len or l.insns[at + 1].leader) break;
            }
            if (l.cur != null) try l.br(try l.blockAt(l.insns[at + 1].pc));
        }
    }

    fn insn(l: *Lowerer, i: analyze.Insn) !void {
        const d = i.depth;
        switch (i.op) {
            .undef, .null, .true, .false, .uninit => try l.storeConst(l.slot(d), literalBits(i.op)),
            .callee => try l.store(l.slot(d), try l.load(0)),
            .this_raw => try l.store(l.slot(d), try l.load(1)),
            .new_target => try l.store(l.slot(d), try l.load(2)),
            .this_sloppy => try l.thisSloppy(l.slot(d)),
            .home => try l.helper(h.home, &.{l.slot(d)}),
            .str => try l.helper(h.str, &.{ l.slot(d), i.a }),
            .rest => try l.helper(h.rest, &.{ l.slot(d), i.a }),
            .arguments => try l.helper(h.arguments, &.{l.slot(d)}),
            .ret_ctor, .ret_this => {
                const result = l.slot(d - (if (i.op == .ret_this) @as(u32, 1) else 2));
                if (i.op == .ret_this) try l.store(result + 1, try l.load(1));
                try l.retCtor(result);
            },
            .jump_if_nullish, .jump_if_not_undef => try l.undefJump(i),
            .push_env => try l.helper(h.pushEnv, &.{i.a}),
            .pop_env => try l.helper(h.popEnv, &.{}),
            .clone_env => try l.helper(h.cloneEnv, &.{}),
            .closure => try l.helper(h.closure, &.{ l.slot(d), i.a }),
            .declare_global => try l.helper(h.declareGlobal, &.{i.a}),
            .store_global => try l.helper(h.storeGlobal, &.{ l.slot(d - 1), i.a, i.b }),
            .set_prop => try l.setProp(i),
            .add_set_prop => {
                try l.binaryOp(.add, l.slot(d - 2));
                var write = i;
                write.depth -= 1;
                try l.setProp(write);
            },
            .add_local_string, .add_local_prop, .add_local_elem, .lt_local_prop, .le_local_prop => {
                const compare = i.op == .lt_local_prop or i.op == .le_local_prop;
                try l.store(l.slot(d), try l.checkedLocal(i.a, i.b));
                if (i.op == .add_local_string) {
                    try l.helper(h.str, &.{ l.slot(d + 1), i.c });
                } else {
                    try l.store(l.slot(d + 1), try l.checkedLocal(i.c, i.d));
                    if (i.op == .add_local_prop or compare) {
                        try l.getProp(l.slot(d + 1), i.tail[0], i.tail[1]);
                    } else {
                        try l.store(l.slot(d + 2), try l.checkedLocal(i.tail[0], i.tail[1]));
                        try l.getElem(l.slot(d + 1));
                    }
                }
                try l.binaryOp(if (compare) bc.localOperator(i.op) else .add, l.slot(d));
                if (!compare) {
                    _ = try l.checkedLocal(i.a, i.b);
                    try l.store(vm.header + i.a, try l.load(l.slot(d)));
                }
            },
            .add_store_local => {
                try l.binaryOp(.add, l.slot(d - 2));
                _ = try l.checkedLocal(i.a, i.b);
                try l.store(vm.header + i.a, try l.load(l.slot(d - 2)));
            },
            .get_elem => try l.getElem(l.slot(d - 2)),
            .get_elem_locals => {
                try l.store(l.slot(d), try l.checkedLocal(i.a, i.b));
                try l.store(l.slot(d + 1), try l.checkedLocal(i.c, i.d));
                try l.getElem(l.slot(d));
            },
            .set_elem => try l.setElem(l.slot(d - 3)),
            .new_object => try l.helper(h.newObject, &.{ l.slot(d), i.a }),
            .new_array => try l.helper(h.newArray, &.{ l.slot(d - i.a), i.a }),
            .define => try l.define(i),
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
            .ret_local => {
                try l.store(l.slot(d), try l.checkedLocal(i.a, i.b));
                try l.store(l.slot(d + 1), try l.load(1));
                try l.retCtor(l.slot(d));
            },
            .load_checked, .local_callee => {
                const v = try l.checkedLocal(i.a, i.b);
                try l.store(l.slot(d), v);
                if (i.op == .local_callee) try l.storeConst(l.slot(d + 1), rt.undefined_value);
            },
            .inc_local, .dec_local => {
                const v = try l.checkedLocal(i.a, i.b);
                // Coercion may throw. Keep the binding intact until the helper has succeeded.
                try l.store(l.slot(d), v);
                try l.unaryOp(if (i.op == .inc_local) .inc else .dec, l.slot(d));
                try l.store(vm.header + i.a, try l.load(l.slot(d)));
            },
            .add_local_int, .sub_local_int, .lt_local_int, .le_local_int, .add_locals, .sub_locals, .lt_locals, .le_locals => {
                try l.store(l.slot(d), try l.checkedLocal(i.a, i.b));
                switch (i.op) {
                    .add_locals, .sub_locals, .lt_locals, .le_locals => try l.store(l.slot(d + 1), try l.checkedLocal(i.c, i.d)),
                    else => try l.storeConst(l.slot(d + 1), rt.number(@floatFromInt(@as(i32, @bitCast(i.c))))),
                }
                try l.binaryOp(bc.localOperator(i.op), l.slot(d));
            },
            .store_checked => {
                _ = try l.checkedLocal(i.a, i.b);
                try l.store(vm.header + i.a, try l.load(l.slot(d - 1)));
            },
            .arg => try l.arg(i.a, l.slot(d)),
            .arg_local => try l.arg(i.a, vm.header + i.b),
            .load_global, .global_callee => {
                try l.globalLoad(i);
                if (i.op == .global_callee) try l.storeConst(l.slot(d + 1), rt.undefined_value);
            },
            .typeof_global => try l.helper(h.loadGlobal, &.{ l.slot(d), i.a, 1 }),
            .inc_env, .dec_env => {
                try l.helper(h.loadEnv, &.{ l.slot(d), i.a, i.b, i.c + 1 });
                try l.unaryOp(if (i.op == .inc_env) .inc else .dec, l.slot(d));
                try l.helper(h.storeEnv, &.{ l.slot(d), i.a, i.b, i.c + 1 });
            },
            .load_env => try l.helper(h.loadEnv, &.{ l.slot(d), i.a, i.b, 0 }),
            .load_env_checked => try l.helper(h.loadEnv, &.{ l.slot(d), i.a, i.b, i.c + 1 }),
            .store_env => try l.helper(h.storeEnv, &.{ l.slot(d - 1), i.a, i.b, 0 }),
            .store_env_checked => try l.helper(h.storeEnv, &.{ l.slot(d - 1), i.a, i.b, i.c + 1 }),
            .get_prop_local => {
                try l.store(l.slot(d), try l.checkedLocal(i.a, i.b));
                try l.getProp(l.slot(d), i.c, i.d);
            },
            .get_prop => try l.getProp(l.slot(d - 1), i.a, i.b),
            .get_method => try l.getMethod(l.slot(d - 1), i.a, i.b),
            .call, .call0, .call1, .call2, .call3 => {
                const base = d - i.a - 2;
                if (i.a == 1) if (l.methodSite(base, "push")) |ic| return l.push(l.slot(base), ic);
                try l.helper(h.call, &.{ l.slot(base), i.a });
            },
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
    var l: Lowerer = .{ .f = f, .t = t, .ctx = ctx, .w = f.newVReg(), .argv = f.newVReg(), .argc = f.newVReg(), .exit = exit, .insns = plan.insns };

    // The entry is written first, so `order` opens with it.
    l.cur = entry;
    try l.emit(.{ .load = .{ .dst = l.w, .base = ctx, .disp = @offsetOf(h.Ctx, "w") } });
    try l.emit(.{ .load = .{ .dst = l.argv, .base = ctx, .disp = @offsetOf(h.Ctx, "argv") } });
    try l.emit(.{ .load = .{ .dst = l.argc, .base = ctx, .disp = @offsetOf(h.Ctx, "argc") } });

    l.cur = exit;
    try l.emit(.{ .ret = try l.konst(imm(c.JSRT_UNDEFINED)) });
    l.cur = entry;

    const dead = try deadStores(f.alloc(), t, plan.insns);
    if (fast_chain) l.loops = try carriedLoops(f, t, plan.insns, dead);
    for (plan.insns, dead, 0..) |i, skip, at| {
        l.at = at;
        if (i.leader) try l.leader(i);
        if (l.fused) {
            l.fused = false;
            continue;
        }
        if (skip) continue;
        if (fast_chain and try l.fast(i)) continue;
        try l.flush();
        try l.payOwed();
        try l.insn(i);
        // It may have called a helper, across which no register of the chain is kept. In a
        // loop with carried locals, which `takenWhole` found no such instruction in, the
        // locals are then read from the window and guarded again where they are next used.
        l.forget();
    }
    try l.payOwed();
    try l.closeLoop();
    try l.generic(dead);
    // A carried register must not span a call, or the backend keeps it in memory. A block a
    // forward jump names was created before the loop's later blocks, so with carried locals
    // the function is laid out in the order its blocks were written: a loop's stay together,
    // and those of them that seldom run come after the rest (`seldom`), so an iteration takes
    // one branch where it would jump over each of them.
    if (l.loops.len != 0) try layout.inOrder(f, l.order.items);
}

/// Pairs of a push without effects and a store into a local nothing reads, both left out: the
/// prologue's `this`, `new.target`, home object and callee in a function that names none of them.
fn deadStores(alloc: std.mem.Allocator, t: *const bc.Template, insns: []const analyze.Insn) ![]bool {
    const read = try alloc.alloc(bool, t.nlocals);
    @memset(read, false);
    for (insns) |i| switch (i.op) {
        .add_local_string, .add_local_prop, .add_local_elem, .lt_local_prop, .le_local_prop => {
            read[i.a] = true;
            if (i.op != .add_local_string) read[i.c] = true;
            if (i.op == .add_local_elem) read[i.tail[0]] = true;
        },
        .load, .load_checked, .local_callee, .ret_local, .add_store_local, .store_checked, .inc_local, .dec_local, .get_prop_local, .add_local_int, .sub_local_int, .lt_local_int, .le_local_int => read[i.a] = true,
        .add_locals, .sub_locals, .lt_locals, .le_locals, .get_elem_locals => {
            read[i.a] = true;
            read[i.c] = true;
        },
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
