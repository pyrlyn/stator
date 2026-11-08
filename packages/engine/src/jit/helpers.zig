//! What native code calls for everything its fast paths do not do: each helper runs the VM's own
//! function for the operation (vm.zig), writes the result into the frame window and answers 1
//! when an exception is pending, so the caller leaves through its exit block. Values never live
//! anywhere but the window, which the collector already roots (docs/ENGINE.md §3).

const rt = @import("../rt.zig");
const c = rt.c;
const vm = @import("../vm.zig");
const bc = @import("../bytecode.zig");
const Value = rt.Value;

/// What a compiled function receives. Field offsets are read by generated code (lower.zig).
pub const Ctx = extern struct {
    /// The frame window: callee, this, new.target, the locals, then the operands.
    w: [*]Value,
    argv: [*]const Value,
    argc: u64,
    frame: *c.JSRTFrame,
    t: *bc.Template,
    /// The function's own environment (vm.zig `fnEnv`), null for a script.
    fe: ?*c.JSRTEnv,
};

fn status() u64 {
    return @intFromBool(rt.pending());
}

/// Writes `v` to window slot `s` and answers the pending status.
fn put(cx: *Ctx, s: u64, v: Value) u64 {
    cx.w[s] = v;
    return status();
}

fn op(o: u64) bc.Op {
    return @fromBackingInt(@as(u8, @intCast(o)));
}

pub fn binary(cx: *Ctx, s: u64, o: u64) callconv(.c) u64 {
    return put(cx, s, vm.binary(op(o), cx.w[s], cx.w[s + 1]));
}

pub fn unary(cx: *Ctx, s: u64, o: u64) callconv(.c) u64 {
    return put(cx, s, vm.unary(op(o), cx.w[s]));
}

/// ToBoolean never throws.
pub fn truthy(v: Value) callconv(.c) u64 {
    return @intFromBool(c.jsrt_truthy(v));
}

pub fn loadGlobal(cx: *Ctx, s: u64, key: u64, typeof_: u64) callconv(.c) u64 {
    return put(cx, s, vm.loadGlobal(cx.t, @intCast(key), typeof_ != 0));
}

pub fn getProp(cx: *Ctx, s: u64, key: u64, ic: u64) callconv(.c) u64 {
    return put(cx, s, vm.getProp(cx.w[s], cx.t.keys[key], &cx.t.ics[ic]));
}

/// callee this args… at `base` -> the result at `base`.
pub fn call(cx: *Ctx, base: u64, argc: u64) callconv(.c) u64 {
    const w = cx.w;
    w[base] = vm.call(w[base], w[base + 1], w[base + 2 .. base + 2 + argc]);
    return status();
}

/// `key1` is the TDZ name's key index plus one, or 0 for a binding without the check.
fn name(cx: *Ctx, key1: u64) ?[*:0]const u8 {
    return if (key1 == 0) null else cx.t.keys[key1 - 1];
}

pub fn loadEnv(cx: *Ctx, s: u64, hops: u64, slot: u64, key1: u64) callconv(.c) u64 {
    return put(cx, s, vm.envLoad(cx.frame.env, @intCast(hops), @intCast(slot), name(cx, key1)));
}

pub fn storeEnv(cx: *Ctx, s: u64, hops: u64, slot: u64, key1: u64) callconv(.c) u64 {
    vm.envStore(cx.frame.env, @intCast(hops), @intCast(slot), name(cx, key1), cx.w[s]);
    return status();
}

pub fn str(cx: *Ctx, s: u64, index: u64) callconv(.c) u64 {
    return put(cx, s, rt.string(cx.t.strings[index]));
}

/// value this at `s` -> what the construction answers at `s`.
pub fn retCtor(cx: *Ctx, s: u64) callconv(.c) u64 {
    return put(cx, s, vm.ctorReturn(cx.t, cx.w[2], cx.w[s], cx.w[s + 1]));
}

pub fn rest(cx: *Ctx, s: u64, from: u64) callconv(.c) u64 {
    return put(cx, s, vm.newArray(cx.argv[@min(from, cx.argc)..cx.argc]));
}

pub fn arguments(cx: *Ctx, s: u64) callconv(.c) u64 {
    return put(cx, s, vm.newArray(cx.argv[0..cx.argc]));
}

pub fn home(cx: *Ctx, s: u64) callconv(.c) u64 {
    return put(cx, s, vm.homeOf(cx.fe));
}

pub fn thisSloppy(cx: *Ctx, s: u64) callconv(.c) u64 {
    return put(cx, s, vm.sloppyThis(cx.w[1]));
}

/// Makes `e` the frame's environment and answers the pending status.
fn enterEnv(cx: *Ctx, e: ?*c.JSRTEnv) u64 {
    cx.frame.env = e;
    return status();
}

pub fn pushEnv(cx: *Ctx, n: u64) callconv(.c) u64 {
    return enterEnv(cx, c.jsrt_env_new(cx.frame.env, @intCast(n)));
}

pub fn popEnv(cx: *Ctx) callconv(.c) u64 {
    return enterEnv(cx, cx.frame.env.*.parent);
}

pub fn cloneEnv(cx: *Ctx) callconv(.c) u64 {
    return enterEnv(cx, c.jsrt_env_clone(cx.frame.env));
}

pub fn closure(cx: *Ctx, s: u64, index: u64) callconv(.c) u64 {
    return put(cx, s, vm.makeClosure(cx.t.funcs[index], cx.frame.env));
}

pub fn declareGlobal(cx: *Ctx, key: u64) callconv(.c) u64 {
    vm.declareGlobal(cx.t.keys[key]);
    return status();
}

pub fn storeGlobal(cx: *Ctx, s: u64, key: u64, strict: u64) callconv(.c) u64 {
    vm.storeGlobal(cx.t, @intCast(key), strict != 0, cx.w[s]);
    return status();
}

/// obj value at `s` -> value at `s`.
pub fn setProp(cx: *Ctx, s: u64, key: u64, ic: u64) callconv(.c) u64 {
    vm.setProp(cx.w[s], cx.t.keys[key], cx.w[s + 1], &cx.t.ics[ic]);
    return put(cx, s, cx.w[s + 1]);
}

pub fn getElem(cx: *Ctx, s: u64) callconv(.c) u64 {
    return put(cx, s, vm.getElem(cx.w[s], cx.w[s + 1]));
}

/// obj key value at `s` -> value at `s`.
pub fn setElem(cx: *Ctx, s: u64) callconv(.c) u64 {
    vm.setElem(cx.w[s], cx.w[s + 1], cx.w[s + 2]);
    return put(cx, s, cx.w[s + 2]);
}

pub fn newObject(cx: *Ctx, s: u64) callconv(.c) u64 {
    return put(cx, s, c.jsrt_dynobj_new());
}

pub fn newArray(cx: *Ctx, s: u64, n: u64) callconv(.c) u64 {
    return put(cx, s, vm.newArray(cx.w[s .. s + n]));
}

/// obj value at `s` -> obj at `s`.
pub fn define(cx: *Ctx, s: u64, key: u64) callconv(.c) u64 {
    vm.defineOwn(cx.w[s], cx.t.keys[key], cx.w[s + 1]);
    return status();
}

/// callee args… at `base` -> the object at `base`.
pub fn construct(cx: *Ctx, base: u64, argc: u64) callconv(.c) u64 {
    const w = cx.w;
    w[base] = vm.construct(w[base], w[base + 1 .. base + 1 + argc], w[base]);
    return status();
}

pub fn throw(cx: *Ctx, s: u64) callconv(.c) u64 {
    c.jsrt_throw(cx.w[s]);
    return 1;
}

pub fn tdz(cx: *Ctx, key: u64) callconv(.c) u64 {
    vm.tdzError(cx.t.keys[key]);
    return 1;
}
