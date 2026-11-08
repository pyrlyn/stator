//! The interpreter's machine (docs/INTERPRETER.md §3). One thread-local value stack holds every
//! interpreted call's window — three call values, the locals, then the operand stack — and each
//! window is published as a `JSRTFrame`, so the collector traces it like a compiled function's.
//! Values are the runtime's `jsrt_value`s and every operation is the runtime's own helper, which
//! is what lets interpreted and compiled code share objects, closures and exceptions.

const std = @import("std");
const rt = @import("rt.zig");
const c = rt.c;
const bc = @import("bytecode.zig");
const compile = @import("compile.zig");
const builtins = @import("builtins.zig");
const jit = @import("jit/jit.zig");
const builtin = @import("builtin");
const Value = rt.Value;
const Op = bc.Op;
const Template = bc.Template;
const Env = c.JSRTEnv;

const stack_values = 1 << 20;

/// The machine's per-thread state in one thread-local, so an activation pays one thread-local
/// lookup rather than one per field (each is a call on macOS).
const Machine = struct {
    stack: []Value = &.{},
    sp: usize = 0,
    /// The runtime's pending-exception flag for this thread, read after every instruction.
    pending: *const volatile bool = undefined,
};
threadlocal var machine: Machine = .{};

fn thisMachine() *Machine {
    const m = &machine;
    if (m.stack.len == 0) {
        m.stack = std.heap.page_allocator.alloc(Value, stack_values) catch @panic("out of memory");
        @memset(m.stack, rt.undefined_value);
        m.pending = c.jsrt_pending_flag();
    }
    return m;
}

// ---------------------------------------------------------------------- internal pointers

/// A pointer the machine keeps in a value slot: tagged undefined, so nothing mistakes it for an
/// object, while the collector — which masks every slot to its payload — still sees it.
fn boxPtr(p: ?*const anyopaque) Value {
    return c.JSRT_BOX(c.JSRT_TAG_UNDEFINED, @intFromPtr(p));
}

fn unboxPtr(comptime T: type, v: Value) ?*T {
    return @ptrCast(@alignCast(c.jsrt_ptr(v)));
}

fn closureOf(v: Value) *c.JSRTClosure {
    return @ptrCast(@alignCast(c.jsrt_ptr(v)));
}

/// An interpreted function: a runtime closure whose code is the trampoline below.
pub fn isInterpreted(v: Value) bool {
    return rt.is(v, c.JSRT_TAG_CLOSURE) and closureOf(v).@"fn" == &trampoline;
}

fn fnEnv(v: Value) *Env {
    return closureOf(v).env;
}

fn templateOf(fe: *Env) *Template {
    return unboxPtr(Template, fe.slots()[compile.fnenv_template]).?;
}

// ---------------------------------------------------------------------- errors

fn keyText(k: [*:0]const u8) []const u8 {
    return std.mem.span(k);
}

/// Throws `ctor` of a message assembled from parts, the runtime copying it.
fn throwFmt(class: *const c.JSRTClass, comptime fmt: []const u8, args: anytype) void {
    var buf: [512]u8 = undefined;
    const msg = std.fmt.bufPrintSentinel(&buf, fmt, args, 0) catch "error";
    c.jsrt_throw_error(class, msg.ptr);
}

/// The TypeError naming `v` that Node raises; answers undefined for the caller to return.
fn throwAbout(v: Value, comptime fmt: []const u8) Value {
    var buf: [128]u8 = undefined;
    throwFmt(&c.jsrt_class_type_error, fmt, .{describe(v, &buf)});
    return rt.undefined_value;
}

fn describe(v: Value, buf: []u8) []const u8 {
    if (rt.is(v, c.JSRT_TAG_STRING) or c.jsrt_is_number(v) or rt.is(v, c.JSRT_TAG_BOOL) or c.jsrt_is_nullish(v)) {
        return rt.copyText(c.jsrt_to_string(v), buf);
    }
    if (rt.is(v, c.JSRT_TAG_CLOSURE)) return std.mem.span(closureOf(v).name);
    return "object";
}

// ---------------------------------------------------------------------- calling

threadlocal var depth_guard: usize = 0;

fn stackExhausted() bool {
    return @frameAddress() < c.jsrt_stack_limit;
}

/// The runtime's entry into an interpreted function: `argv[0]` is the receiver.
fn trampoline(argc: u32, argv: [*c]const Value, env: [*c]Env) callconv(.c) Value {
    const fe: *Env = env;
    const this = if (argc > 0) argv[0] else rt.undefined_value;
    const args = if (argc > 1) argv[1..argc] else &[_]Value{};
    return callInterpreted(fe, fe.slots()[compile.fnenv_self], this, args);
}

/// [[Call]] of an interpreted function: a class constructor refuses it.
fn callInterpreted(fe: *Env, callee: Value, this: Value, args: []const Value) Value {
    const t = templateOf(fe);
    if (t.kind.ctor()) {
        throwFmt(&c.jsrt_class_type_error, "Class constructor {s} cannot be invoked without 'new'", .{std.mem.span(t.name)});
        return rt.undefined_value;
    }
    if (t.is_async and t.generator) return startAsyncGenerator(t, fe, callee, this, args);
    if (t.is_async) return startAsync(t, fe, callee, this, args);
    if (t.generator) return startGenerator(t, fe, callee, this, args);
    return run(t, fe, callee, this, args, rt.undefined_value);
}

/// A call from compiled code to a compiled plain function (jit/helpers.zig `call`): the callee's
/// window opens where `exec` would open it and its code runs with no interpreter layer between.
/// Null when `callee` needs [[Call]]'s full path.
pub fn callCompiled(st: *const jit.Stack, callee: Value, this: Value, args: []const Value) ?Value {
    if (!isInterpreted(callee)) return null;
    const fe = fnEnv(callee);
    const t = templateOf(fe);
    if (!t.jit.direct) return null;
    if (@frameAddress() < st.limit) return c.jsrt_stack_overflow();
    const base = st.sp.*;
    const window = windowSize(t);
    if (base + window > st.values.len) {
        rt.throwRange("Maximum call stack size exceeded");
        return rt.undefined_value;
    }
    st.sp.* = base + window;
    defer st.sp.* = base;
    const w = st.values[base .. base + window];
    @memset(w, rt.undefined_value);
    w[0] = callee;
    w[1] = this;
    var frame: c.JSRTFrame = .{ .prev = st.top.*, .count = @intCast(window), .slots = w.ptr, .env = fe.parent };
    st.top.* = &frame;
    defer st.top.* = frame.prev;
    return jit.enter(@ptrCast(@alignCast(t.jit.code.?)), t, fe, w.ptr, args, &frame, st);
}

/// Calls any value with a receiver; a non-function is the TypeError Node raises.
pub fn call(callee: Value, this: Value, args: []const Value) Value {
    if (!rt.is(callee, c.JSRT_TAG_CLOSURE)) return throwAbout(callee, "{s} is not a function");
    if (isInterpreted(callee)) return callInterpreted(fnEnv(callee), callee, this, args);
    return c.jsrt_call_with_this(callee, this, @intCast(args.len), args.ptr);
}

pub fn isConstructor(v: Value) bool {
    if (!rt.is(v, c.JSRT_TAG_CLOSURE)) return false;
    if (isInterpreted(v)) return templateOf(fnEnv(v)).constructible();
    const clo = closureOf(v);
    return clo.constructible or clo.klass != null or builtins.isConstructor(v);
}

/// A new ordinary object whose prototype is `proto` when that is an object.
fn objectWithProto(proto: Value) Value {
    const obj = c.jsrt_dynobj_new();
    if (rt.isObjectLike(proto)) dynObj(obj).proto = proto;
    return obj;
}

fn dynObj(v: Value) *c.JSRTDynObject {
    return @ptrCast(@alignCast(c.jsrt_ptr(v)));
}

fn isDyn(v: Value) bool {
    return rt.is(v, c.JSRT_TAG_OBJECT) and c.jsrt_is_dynobj(v);
}

/// `new callee(...args)` with `nt` as new.target (§7.3.14 Construct).
pub fn construct(callee: Value, args: []const Value, nt: Value) Value {
    if (!isConstructor(callee)) return throwAbout(callee, "{s} is not a constructor");
    if (isInterpreted(callee)) {
        const fe = fnEnv(callee);
        const t = templateOf(fe);
        var this = rt.uninitialized;
        if (t.kind != .derived_ctor) {
            const proto = getProp(nt, "prototype", null);
            if (rt.pending()) return rt.undefined_value;
            this = objectWithProto(proto);
        }
        return run(t, fe, callee, this, args, nt);
    }
    if (builtins.isConstructor(callee)) return builtins.construct(callee, args, nt);
    const made = c.jsrt_construct(callee, @intCast(args.len), args.ptr);
    // A subclass of a runtime constructor: the instance takes the subclass's prototype.
    if (!rt.pending() and nt != callee and isDyn(made)) {
        const proto = getProp(nt, "prototype", null);
        if (rt.isObjectLike(proto)) dynObj(made).proto = proto;
    }
    return made;
}

// ---------------------------------------------------------------------- properties

/// [[Get]], with the reads the runtime cannot answer for an interpreted program.
pub fn getProp(obj: Value, key: [*:0]const u8, ic: ?*c.JSRTIC) Value {
    if (ic) |site| if (isDyn(obj)) if (cachedSlot(dynObj(obj), key, site)) |slot| return slot.*;
    if (c.jsrt_is_error(obj) and std.mem.eql(u8, keyText(key), "constructor")) return builtins.errorConstructorOf(obj);
    if (rt.is(obj, c.JSRT_TAG_CLOSURE)) return closureGet(obj, key);
    // The runtime's generator object keeps no properties; its methods are the prototype's.
    if (c.jsrt_is_generator(obj)) return c.jsrt_get_prop(if (isAsyncGenerator(obj)) builtins.asyncGeneratorPrototype() else builtins.generatorPrototype(), key, null);
    // Likewise a promise: `then` and its kin are installed on the prototype by builtins.
    if (c.jsrt_is_promise(obj)) return c.jsrt_get_prop(c.jsrt_builtin_proto("Promise"), key, null);
    if (rt.is(obj, c.JSRT_TAG_STRING)) {
        if (builtins.stringMethod(obj, key)) |m| return m;
    }
    const v = c.jsrt_get_prop(obj, key, ic);
    if (std.mem.eql(u8, keyText(key), "constructor")) return builtins.globalConstructor(v);
    return v;
}

/// Whether `f`'s own property table holds `key` (its `name`, `length` and `prototype` aside).
pub fn closureHasOwn(f: Value, key: [*:0]const u8) bool {
    const props = closureOf(f).props orelse return false;
    return c.jsrt_shape_find(props.*.shape, key) != null;
}

/// `f`'s own property table as an object value, or null when it has none yet.
pub fn closureProps(f: Value) ?Value {
    const props = closureOf(f).props orelse return null;
    return c.JSRT_BOX(c.JSRT_TAG_OBJECT, @intFromPtr(props));
}

/// A function's property: its own first — the runtime answers `name` and `length` before them,
/// and a `static name()` must shadow the name — then the runtime's, then Function.prototype's.
fn closureGet(f: Value, key: [*:0]const u8) Value {
    const clo = closureOf(f);
    if (clo.props) |props| {
        if (c.jsrt_shape_find(props.*.shape, key)) |hit| {
            const slot = props.*.slots[hit.*.offset];
            if (!c.jsrt_is_accessor_cell(slot)) return slot;
            const cell: *c.JSRTAccessorCell = @ptrCast(@alignCast(c.jsrt_ptr(slot)));
            return if (cell.get == rt.undefined_value) rt.undefined_value else call(cell.get, f, &.{});
        }
    }
    const v = c.jsrt_get_prop(f, key, null);
    if (v != rt.undefined_value or rt.pending()) return v;
    const fv = c.jsrt_get_prop(builtins.functionPrototype(), key, null);
    if (fv != rt.undefined_value or rt.pending()) return fv;
    // Function.prototype's [[Prototype]] is Object.prototype (§20.2.3).
    return c.jsrt_get_prop(builtins.objectPrototype(), key, null);
}

pub fn setProp(obj: Value, key: [*:0]const u8, v: Value, ic: ?*c.JSRTIC) void {
    if (c.jsrt_is_nullish(obj)) {
        throwFmt(&c.jsrt_class_type_error, "Cannot set properties of {s} (setting '{s}')", .{ if (obj == rt.null_value) "null" else "undefined", keyText(key) });
        return;
    }
    if (!rt.isObjectLike(obj)) return; // a primitive's property write is dropped
    if (ic) |site| if (isDyn(obj) and !dynObj(obj).frozen) if (cachedSlot(dynObj(obj), key, site)) |slot| return writeSlot(dynObj(obj), slot, v);
    c.jsrt_set_prop(obj, key, v, ic);
}

/// The own data slot a site's inline cache names on `o`, when the cache holds: `o` is on the shape
/// the runtime filled it from, which fixes the key's offset. Only a data property is answered here;
/// an accessor runs code, and `constructor` has getProp's own answer, so both take the full path.
fn cachedSlot(o: *c.JSRTDynObject, key: [*:0]const u8, ic: *const c.JSRTIC) ?*Value {
    if (ic.shape != @as(?*const c.JSRTShape, o.shape)) return null;
    if (key[0] == 'c' and std.mem.orderZ(u8, key, "constructor") == .eq) return null;
    const slot = &o.slots[ic.offset];
    return if (c.jsrt_is_accessor_cell(slot.*)) null else slot;
}

/// A store into `owner`'s own slot, behind the collector's write barrier. The barrier is given the
/// owner, not the slot: an object already dirty and named by its own address is its lock-free case.
fn writeSlot(owner: *c.JSRTDynObject, slot: *Value, v: Value) void {
    c.jsrt_gc_write(owner);
    slot.* = v;
}

/// `index` as an array index below `len`, or null: the read and write fast paths take only a
/// number naming an existing element, so holes, growth and string keys stay the runtime's.
fn denseIndex(index: Value, len: u32) ?u32 {
    if (!c.jsrt_is_number(index)) return null;
    const d = c.jsrt_number_value(index);
    if (!(d >= 0 and d < @as(f64, @floatFromInt(len)))) return null;
    const i: u32 = @intFromFloat(d);
    return if (@as(f64, @floatFromInt(i)) == d) i else null;
}

pub fn getElem(obj: Value, k: Value) Value {
    if (rt.is(obj, c.JSRT_TAG_ARRAY)) {
        const a = c.jsrt_as_array(obj);
        if (denseIndex(k, a.*.length)) |i| return c.jsrt_unhole(a.*.elements[i]);
    }
    if (c.jsrt_is_nullish(obj)) {
        var buf: [128]u8 = undefined;
        throwFmt(&c.jsrt_class_type_error, "Cannot read properties of {s} (reading '{s}')", .{ if (obj == rt.null_value) "null" else "undefined", describe(k, &buf) });
        return rt.undefined_value;
    }
    if (rt.is(k, c.JSRT_TAG_STRING) and c.jsrt_is_error(obj)) {
        const p = c.jsrt_shape_key(k);
        return getProp(obj, p, null);
    }
    return c.jsrt_dyn_index_get(obj, k, null);
}

pub fn setElem(obj: Value, k: Value, v: Value) void {
    if (c.jsrt_is_nullish(obj)) {
        var buf: [128]u8 = undefined;
        throwFmt(&c.jsrt_class_type_error, "Cannot set properties of {s} (setting '{s}')", .{ if (obj == rt.null_value) "null" else "undefined", describe(k, &buf) });
        return;
    }
    if (!rt.isObjectLike(obj)) return;
    if (rt.is(obj, c.JSRT_TAG_ARRAY)) {
        const a = c.jsrt_as_array(obj);
        if (denseIndex(k, a.*.length)) |i| {
            c.jsrt_gc_write(a);
            a.*.elements[i] = v;
            return;
        }
    }
    c.jsrt_dyn_index_set(obj, k, v, null);
}

/// ToPropertyKey for a computed name: objects become strings, primitives stay as they are.
fn toKey(v: Value) Value {
    if (rt.isObjectLike(v)) return c.jsrt_to_string(c.jsrt_to_primitive(v, c.JSRT_HINT_STRING));
    return v;
}

fn keyOf(v: Value) [*:0]const u8 {
    return c.jsrt_shape_key(c.jsrt_to_string(v));
}

/// Where a closure's own properties live: its `props` object, made on first use.
fn ownTable(obj: Value) Value {
    if (!rt.is(obj, c.JSRT_TAG_CLOSURE)) return obj;
    const clo = closureOf(obj);
    if (clo.props == null) clo.props = @ptrCast(@alignCast(c.jsrt_ptr(c.jsrt_dynobj_new())));
    return c.JSRT_BOX(c.JSRT_TAG_OBJECT, @intFromPtr(clo.props));
}

/// CreateDataProperty: an own property, whatever setter the prototype chain has for the key.
pub fn defineOwn(obj_in: Value, key: [*:0]const u8, v: Value) void {
    const obj = ownTable(obj_in);
    if (!isDyn(obj)) return c.jsrt_set_prop(obj, key, v, null);
    const o = dynObj(obj);
    if (c.jsrt_shape_find(o.shape, key)) |hit| {
        o.slots[hit.*.offset] = v;
        return;
    }
    const next = c.jsrt_shape_transition(o.shape, key);
    c.jsrt_shape_reserve(&o.slots, &o.capacity, next.*.offset);
    o.slots[next.*.offset] = v;
    o.shape = next;
}

pub fn defineAccessor(obj_in: Value, key: [*:0]const u8, f: Value, setter: bool) void {
    const obj = ownTable(obj_in);
    const pair = ownAccessor(obj, key) orelse [2]Value{ rt.undefined_value, rt.undefined_value };
    var get = pair[0];
    var set = pair[1];
    if (setter) set = f else get = f;
    c.jsrt_define_accessor(obj, key, get, set);
}

/// CopyDataProperties (§7.3.25) without an exclusion list: object rest deletes its named keys
/// from the copy afterwards.
fn copyDataProperties(dst: Value, src: Value) void {
    if (rt.is(src, c.JSRT_TAG_OBJECT) and !c.jsrt_is_dynobj(src)) {
        _ = c.jsrt_dynobj_spread(dst, src);
        return;
    }
    if (!rt.isObjectLike(src) and !rt.is(src, c.JSRT_TAG_STRING)) return;
    var keys: builtins.Frame(1) = .{};
    keys.open(.{c.jsrt_object_keys(src)});
    defer keys.pop();
    for (arrayItems(keys.slots[0])) |k| {
        const v = getElem(src, k);
        if (rt.pending()) return;
        defineOwn(dst, keyOf(k), v);
    }
}

/// The getter and setter of an own accessor property, or null for a data property or none.
pub fn ownAccessor(obj_in: Value, key: [*:0]const u8) ?[2]Value {
    const obj = ownTable(obj_in);
    if (!isDyn(obj)) return null;
    const o = dynObj(obj);
    const hit = c.jsrt_shape_find(o.shape, key) orelse return null;
    const slot = o.slots[hit.*.offset];
    if (!c.jsrt_is_accessor_cell(slot)) return null;
    const cell: *c.JSRTAccessorCell = @ptrCast(@alignCast(c.jsrt_ptr(slot)));
    return .{ cell.get, cell.set };
}

/// The prototype `super.x` reads from: the home object's.
fn protoOf(v: Value) Value {
    if (isDyn(v)) {
        const p = dynObj(v).proto;
        return if (p == 0) builtins.objectPrototype() else p;
    }
    if (isInterpreted(v)) return fnEnv(v).slots()[compile.fnenv_parent];
    return rt.undefined_value;
}

/// Object.getPrototypeOf, as far as the runtime's objects keep one.
pub fn prototypeOf(v: Value) Value {
    if (isDyn(v)) return protoOf(v);
    if (isInterpreted(v)) {
        const p = protoOf(v);
        return if (rt.isObjectLike(p)) p else c.jsrt_builtin_proto("Function");
    }
    if (rt.is(v, c.JSRT_TAG_CLOSURE)) return c.jsrt_builtin_proto("Function");
    if (rt.is(v, c.JSRT_TAG_ARRAY)) return c.jsrt_builtin_proto("Array");
    if (rt.isObjectLike(v)) return builtins.objectPrototype();
    return rt.null_value;
}

/// Object.setPrototypeOf for the objects whose prototype the runtime stores.
pub fn setProto(v: Value, proto: Value) void {
    if (!rt.isObjectLike(proto) and proto != rt.null_value) {
        throwFmt(&c.jsrt_class_type_error, "Object prototype may only be an Object or null", .{});
        return;
    }
    if (isDyn(v)) {
        dynObj(v).proto = proto;
    } else if (isInterpreted(v)) {
        fnEnv(v).slots()[compile.fnenv_parent] = proto;
    }
}

fn instanceOf(v: Value, ctor: Value) bool {
    if (!rt.isObjectLike(ctor)) {
        throwFmt(&c.jsrt_class_type_error, "Right-hand side of 'instanceof' is not callable", .{});
        return false;
    }
    if (builtins.instanceOf(v, ctor)) |answer| return answer;
    if (!isInterpreted(ctor)) return c.jsrt_instanceof_ctor(v, ctor);
    if (!rt.isObjectLike(v)) return false;
    const proto = getProp(ctor, "prototype", null);
    if (rt.pending()) return false;
    if (!rt.isObjectLike(proto)) {
        throwFmt(&c.jsrt_class_type_error, "Function has non-object prototype in instanceof check", .{});
        return false;
    }
    var p = if (isDyn(v)) dynObj(v).proto else rt.undefined_value;
    while (rt.isObjectLike(p)) {
        if (p == proto) return true;
        p = if (isDyn(p)) dynObj(p).proto else rt.undefined_value;
    }
    return false;
}

// ---------------------------------------------------------------------- iteration

/// An iterator record (§7.4.1): an array of the iterator, its `next` (undefined for one the
/// runtime drives itself), and whether it is done.
const rec_iter = 0;
const rec_next = 1;
const rec_done = 2;
/// An async iterator record only: true when the iterator is a sync record (at `rec_iter`) seen
/// through §27.1.6 CreateAsyncFromSyncIterator.
const rec_wrapped = 3;

fn recSlots(rec: Value) [*]Value {
    const arr: *c.JSRTArray = @ptrCast(@alignCast(c.jsrt_ptr(rec)));
    return arr.elements;
}

const iterator_key = "__@iterator";

pub fn getIterator(v: Value) Value {
    var items = [3]Value{ rt.undefined_value, rt.undefined_value, rt.false_value };
    // A generator is driven by the runtime itself, `return()` and all.
    if (c.jsrt_is_generator(v) and !isAsyncGenerator(v)) {
        items[rec_iter] = v;
        return c.jsrt_array_new(3, &items);
    }
    const method = if (rt.isObjectLike(v)) getProp(v, iterator_key, null) else rt.undefined_value;
    if (rt.pending()) return rt.undefined_value;
    if (rt.is(method, c.JSRT_TAG_CLOSURE)) {
        const it = call(method, v, &.{});
        if (rt.pending()) return rt.undefined_value;
        if (!rt.isObjectLike(it)) {
            throwFmt(&c.jsrt_class_type_error, "Result of the Symbol.iterator method is not an object", .{});
            return rt.undefined_value;
        }
        items[rec_iter] = it;
        // The record keeps `it` reachable while `next` is read.
        const rec = c.jsrt_array_new(3, &items);
        const next = getProp(it, "next", null);
        if (rt.pending()) return rt.undefined_value;
        recSlots(rec)[rec_next] = next;
        return rec;
    }
    if (c.jsrt_is_nullish(v) or !rt.isObjectLike(v) and !rt.is(v, c.JSRT_TAG_STRING) or isAsyncGenerator(v)) {
        var buf: [128]u8 = undefined;
        throwFmt(&c.jsrt_class_type_error, "{s} is not iterable", .{describe(v, &buf)});
        return rt.undefined_value;
    }
    items[rec_iter] = c.jsrt_get_iterator(v);
    if (rt.pending()) return rt.undefined_value;
    return c.jsrt_array_new(3, &items);
}

/// IteratorStep: the next value into `out`, or false when the iterator is done (or threw).
pub fn iterStep(rec: Value, out: *Value) bool {
    const s = recSlots(rec);
    if (s[rec_done] == rt.true_value) return false;
    // A `next` that throws leaves the record done (§7.4.4).
    s[rec_done] = rt.true_value;
    if (s[rec_next] == rt.undefined_value) {
        if (!c.jsrt_iterator_step(s[rec_iter], out)) return false;
        if (rt.pending()) return false;
        recSlots(rec)[rec_done] = rt.false_value;
        return true;
    }
    const r = call(s[rec_next], s[rec_iter], &.{});
    if (rt.pending()) return false;
    if (!rt.isObjectLike(r)) {
        var buf: [128]u8 = undefined;
        throwFmt(&c.jsrt_class_type_error, "Iterator result {s} is not an object", .{describe(r, &buf)});
        return false;
    }
    const done = getProp(r, "done", null);
    if (rt.pending()) return false;
    if (c.jsrt_truthy(done)) return false;
    out.* = getProp(r, "value", null);
    if (rt.pending()) return false;
    recSlots(rec)[rec_done] = rt.false_value;
    return true;
}

fn iterClose(rec: Value) void {
    const s = recSlots(rec);
    if (s[rec_done] == rt.true_value) return;
    s[rec_done] = rt.true_value;
    if (s[rec_next] == rt.undefined_value) return c.jsrt_iterator_close(s[rec_iter]);
    const ret = getProp(s[rec_iter], "return", null);
    if (rt.pending() or c.jsrt_is_nullish(ret)) return;
    const r = call(ret, recSlots(rec)[rec_iter], &.{});
    if (rt.pending()) return;
    if (!rt.isObjectLike(r)) throwFmt(&c.jsrt_class_type_error, "Iterator result is not an object", .{});
}

/// GetIterator(obj, async) (§7.4.3): `[Symbol.asyncIterator]`, or the sync iterator wrapped.
fn getAsyncIterator(v: Value) Value {
    const method = if (rt.isObjectLike(v)) getProp(v, "__@asyncIterator", null) else rt.undefined_value;
    if (rt.pending()) return rt.undefined_value;
    var items = [4]Value{ rt.undefined_value, rt.undefined_value, rt.false_value, rt.false_value };
    if (c.jsrt_is_nullish(method)) {
        items[rec_iter] = getIterator(v);
        if (rt.pending()) return rt.undefined_value;
        items[rec_wrapped] = rt.true_value;
        return c.jsrt_array_new(4, &items);
    }
    const it = call(method, v, &.{});
    if (rt.pending()) return rt.undefined_value;
    if (!rt.isObjectLike(it)) {
        throwFmt(&c.jsrt_class_type_error, "Result of the Symbol.asyncIterator method is not an object", .{});
        return rt.undefined_value;
    }
    items[rec_iter] = it;
    const rec = c.jsrt_array_new(4, &items);
    const next = getProp(it, "next", null);
    if (rt.pending()) return rt.undefined_value;
    recSlots(rec)[rec_next] = next;
    return rec;
}

/// One step of `yield*` in a sync generator (§15.5.5, steps 7.a–c): the inner iterator's
/// `next`, `throw` or `return` with what the outer generator received. Answers 0 to yield
/// `out`, 1 when the delegation ended with `out`, 2 when the generator returns `out`.
fn delegateStep(rec: Value, received: Value, mode: u8, out: *Value) u8 {
    const r = switch (delegateCall(rec, received, mode)) {
        .result => |r| r,
        .no_throw => {
            iterClose(rec);
            if (!rt.pending()) rt.throwType(no_throw_method);
            return 0;
        },
        .no_return => {
            out.* = received;
            return 2;
        },
    };
    if (rt.pending()) return 0;
    return delegateResult(r, mode, out);
}

const no_throw_method = "The iterator does not provide a 'throw' method";

/// The call half of a `yield*` step: what the inner iterator's `next`, `throw` or `return`
/// answered, or which of the last two it lacks.
const DelegateCall = union(enum) { result: Value, no_throw, no_return };

fn delegateCall(rec: Value, received: Value, mode: u8) DelegateCall {
    const s = recSlots(rec);
    const it = s[rec_iter];
    const runtime = s[rec_next] == rt.undefined_value;
    switch (mode) {
        c.JSRT_GEN_INJECT_NONE => return .{ .result = if (runtime) c.jsrt_iterator_next(it, received) else call(s[rec_next], it, &.{received}) },
        // A runtime-driven iterator other than a generator has neither method.
        c.JSRT_GEN_INJECT_THROW => if (runtime)
            return if (c.jsrt_is_generator(it)) .{ .result = c.jsrt_generator_throw(it, received) } else .no_throw
        else
            return callMethodOr(it, "throw", received, .no_throw),
        else => if (runtime)
            return if (c.jsrt_is_generator(it)) .{ .result = c.jsrt_generator_close(it, received) } else .no_return
        else
            return callMethodOr(it, "return", received, .no_return),
    }
}

/// `it[name](received)`, or `missing` when `it` has no such method.
fn callMethodOr(it: Value, name: [*:0]const u8, received: Value, missing: DelegateCall) DelegateCall {
    const m = getProp(it, name, null);
    if (rt.pending()) return .{ .result = rt.undefined_value };
    if (c.jsrt_is_nullish(m)) return missing;
    return .{ .result = call(m, it, &.{received}) };
}

/// The result half: 0 to yield `out`, 1 when the delegation ended with `out`, 2 when the
/// generator returns `out` (§15.5.5 steps 7.a.vi, 7.c.viii).
fn delegateResult(r: Value, mode: u8, out: *Value) u8 {
    if (!rt.isObjectLike(r)) {
        _ = throwAbout(r, "Iterator result {s} is not an object");
        return 0;
    }
    const done = getProp(r, "done", null);
    if (rt.pending()) return 0;
    out.* = getProp(r, "value", null);
    if (rt.pending() or !c.jsrt_truthy(done)) return 0;
    return if (mode == c.JSRT_GEN_INJECT_RETURN) 2 else 1;
}

/// `async_delegate`'s mode for a delegation that lost its iterator for want of `throw`: the
/// closing `return()` result is awaited, then the TypeError is thrown.
const delegate_no_throw = 3;
/// …and for a `return` the iterator has no method for: the received value is awaited and
/// returned (§15.5.5 step 7.c.iii).
const delegate_no_return = 4;

/// The call half of an async generator's `yield*` step, whose result the code awaits next.
/// A sync iterable's record goes through its sync iterator (§27.1.6.1); `mode` comes back
/// changed when a method was missing.
fn asyncDelegateCall(rec: Value, received: Value, mode: *u8) Value {
    const s = recSlots(rec);
    const wrapped = s[rec_wrapped] == rt.true_value;
    const target = if (wrapped) s[rec_iter] else rec;
    switch (delegateCall(target, received, mode.*)) {
        .result => |r| return r,
        .no_return => {
            mode.* = delegate_no_return;
            return received;
        },
        .no_throw => {
            mode.* = delegate_no_throw;
            if (wrapped) {
                iterClose(target);
                return rt.undefined_value;
            }
            const m = getProp(s[rec_iter], "return", null);
            if (rt.pending() or c.jsrt_is_nullish(m)) return rt.undefined_value;
            return call(m, recSlots(rec)[rec_iter], &.{});
        },
    }
}

/// The settled half: like `delegateResult`, plus 3 for a sync iterable's value, which is
/// awaited before it is yielded (§27.1.6.4 AsyncFromSyncIteratorContinuation).
fn asyncDelegateResult(rec: Value, settled: Value, mode: u8, out: *Value) u8 {
    switch (mode) {
        delegate_no_throw => {
            rt.throwType(no_throw_method);
            return 0;
        },
        delegate_no_return => {
            out.* = settled;
            return 2;
        },
        else => {
            const kind = delegateResult(settled, mode, out);
            return if (kind == 0 and recSlots(rec)[rec_wrapped] == rt.true_value) 3 else kind;
        },
    }
}

pub fn arrayItems(arr: Value) []Value {
    const a: *c.JSRTArray = @ptrCast(@alignCast(c.jsrt_ptr(arr)));
    return a.elements[0..a.length];
}

// ---------------------------------------------------------------------- closures and classes

/// The environment an activation of `t` owns, whose parent is the scope it closes over.
fn templateEnv(t: *Template, scope: ?*Env) *Env {
    const fe = c.jsrt_env_new(scope, compile.fnenv_size);
    fe.*.slots()[compile.fnenv_template] = boxPtr(t);
    return fe;
}

pub fn makeClosure(t: *Template, scope: ?*Env) Value {
    const fe = templateEnv(t, scope);
    // No allocation between making the closure and storing it: a boxed value in a Zig local is
    // not a root.
    const f = c.jsrt_closure_new(&trampoline, t.arity, t.name, fe, true);
    fe.*.slots()[compile.fnenv_self] = f;
    if (t.kind == .function and t.constructible()) _ = c.jsrt_closure_constructible(f);
    return f;
}

/// heritage ctor -> ctor proto (§15.7.14 ClassDefinitionEvaluation steps 5–8).
fn classSetup(heritage: Value, ctor: Value, has_heritage: bool) ?Value {
    var proto_parent: Value = 0;
    if (has_heritage) {
        if (heritage == rt.null_value) {
            proto_parent = rt.null_value;
        } else if (!isConstructor(heritage)) {
            var buf: [128]u8 = undefined;
            throwFmt(&c.jsrt_class_type_error, "Class extends value {s} is not a constructor or null", .{describe(heritage, &buf)});
            return null;
        } else {
            const p = getProp(heritage, "prototype", null);
            if (rt.pending()) return null;
            if (!rt.isObjectLike(p) and p != rt.null_value) {
                var buf: [128]u8 = undefined;
                throwFmt(&c.jsrt_class_type_error, "Class extends value does not have valid prototype property {s}", .{describe(p, &buf)});
                return null;
            }
            proto_parent = p;
        }
        fnEnv(ctor).slots()[compile.fnenv_parent] = heritage;
    }
    const proto = if (proto_parent == rt.null_value) c.jsrt_null_proto_new() else objectWithProto(proto_parent);
    const clo = closureOf(ctor);
    clo.constructible = true;
    clo.has_prototype = true;
    clo.prototype = proto;
    dynObj(proto).ctor = ctor;
    return proto;
}

// ---------------------------------------------------------------------- the machine

/// The environment `hops` levels out from `e`.
pub fn outward(e: *Env, hops: u8) *Env {
    var at = e;
    for (0..hops) |_| at = at.parent;
    return at;
}

/// Runs a direct eval's code (docs/INTERPRETER.md §3): `cells` are the caller's bindings, each a
/// pointer into an environment or a module global, and the outermost scope the code resolves
/// against. `this` is the caller's.
pub fn runEval(t: *Template, cells: []const *Value, this: Value) Value {
    const refs = c.jsrt_env_new(null, @intCast(cells.len));
    for (refs.*.slots()[0..cells.len], cells) |*slot, cell| slot.* = boxPtr(cell);
    // The script's own environment is this one's child, as a closure's is its scope's.
    return run(t, templateEnv(t, refs), rt.undefined_value, this, &.{}, rt.undefined_value);
}

/// `new Function(…)`'s result: a closure over `t` in the global scope.
pub fn globalClosure(t: *Template) Value {
    return makeClosure(t, null);
}

/// Runs one activation of `t`. `fe` is the closure's environment (null for a script).
pub fn run(t: *Template, fe: ?*Env, callee: Value, this_in: Value, argv: []const Value, nt: Value) Value {
    return exec(t, fe, .{ .call = .{ .callee = callee, .this = this_in, .argv = argv, .nt = nt } });
}

// ---------------------------------------------------------------------- suspension

/// A suspended activation (docs/INTERPRETER.md §5) is an environment: its parent is the scope the
/// code stopped in, its slots say where and how it stopped, then hold the frame's window — the
/// three call values, the locals and the live operands.
const st_pc = 0;
const st_depth = 1;
const st_stop = 2;
const st_running = 3;
/// The arguments of an async call, which runs from inside `jsrt_async_start`.
const st_args = 4;
const st_window = 5;

const Stop = enum(u8) {
    /// Made, nothing run yet (an async call).
    call,
    /// A generator after its parameters, before its body (§15.5.3 EvaluateBody).
    start,
    yield,
    await,
};

pub const header = 3;

fn windowSize(t: *const Template) usize {
    return header + t.nlocals + t.max_stack;
}

/// The state the activation that suspended last saved, for its driver to take right after.
threadlocal var suspended: ?*Env = null;

fn takeSuspended() ?*Env {
    defer suspended = null;
    return suspended;
}

fn intOf(v: Value) usize {
    return @intFromFloat(c.jsrt_to_number(v));
}

fn stopOf(st: *Env) Stop {
    return @fromBackingInt(@intCast(intOf(st.slots()[st_stop])));
}

/// An environment pointer in a value slot the collector traces as a reference.
fn boxEnv(e: ?*Env) Value {
    return c.JSRT_BOX(c.JSRT_TAG_OBJECT, @intFromPtr(e));
}

/// A suspendable activation of `t` that has not run: an async call's.
fn newState(t: *Template, fe: *Env, callee: Value, this: Value, args: []const Value) *Env {
    const st = c.jsrt_env_new(fe.parent, @intCast(st_window + windowSize(t)));
    const s = st.*.slots();
    s[st_stop] = rt.number(@backingInt(Stop.call));
    s[st_pc] = rt.number(0);
    s[st_depth] = rt.number(0);
    s[st_running] = rt.false_value;
    s[st_window] = callee;
    s[st_window + 1] = this;
    s[st_args] = c.jsrt_array_new(@intCast(args.len), args.ptr);
    return st;
}

fn templateOfState(st: *Env) *Template {
    return templateOf(fnEnv(st.slots()[st_window]));
}

/// Runs a suspended activation on from where it stopped. `mode` is the generator's injection
/// (`JSRT_GEN_INJECT_*`); for an `await`, THROW is a rejection.
fn resumeState(st: *Env, sent: Value, mode: u8) Value {
    const s = st.slots();
    s[st_running] = rt.true_value;
    defer st.slots()[st_running] = rt.false_value;
    const callee = s[st_window];
    const t = templateOfState(st);
    if (stopOf(st) == .call) {
        return exec(t, fnEnv(callee), .{ .call = .{ .callee = callee, .this = s[st_window + 1], .argv = arrayItems(s[st_args]), .nt = rt.undefined_value, .state = st } });
    }
    return exec(t, fnEnv(callee), .{ .resume_ = .{ .state = st, .sent = sent, .mode = mode } });
}

fn isRunning(st: *Env) bool {
    return st.slots()[st_running] == rt.true_value;
}

// ---- generators

/// A generator call runs the parameters, then stops at the body's `start` and hands the state to
/// the runtime's generator object (§27.5.3.1 GeneratorStart).
fn startGenerator(t: *Template, fe: *Env, callee: Value, this: Value, args: []const Value) Value {
    _ = takeSuspended();
    const r = exec(t, fe, .{ .call = .{ .callee = callee, .this = this, .argv = args, .nt = rt.undefined_value } });
    const st = takeSuspended() orelse return r;
    return handOff(st, c.jsrt_generator_new, &genResume);
}

/// The runtime object `make` builds around the state, which stays rooted while it allocates.
fn handOff(st: *Env, comptime make: anytype, resume_fn: anytype) Value {
    var root: builtins.Frame(1) = .{};
    root.open(.{boxEnv(st)});
    defer root.pop();
    return make(st, resume_fn);
}

fn genResume(self: [*c]c.JSRTGenerator, sent: Value) callconv(.c) void {
    const g: *c.JSRTGenerator = self;
    const st: *Env = g.env;
    const mode = g.inject;
    g.inject = c.JSRT_GEN_INJECT_NONE;
    if (isRunning(st)) return rt.throwType("Generator is already running");
    g.state = 1;
    const r = resumeState(st, sent, mode);
    if (takeSuspended() != null) return c.jsrt_generator_yield(g, r);
    if (rt.pending()) {
        g.done = true;
        g.yielded = rt.undefined_value;
    } else c.jsrt_generator_return(g, r);
}

// ---- async functions

fn startAsync(t: *Template, fe: *Env, callee: Value, this: Value, args: []const Value) Value {
    return handOff(newState(t, fe, callee, this, args), c.jsrt_async_start, &asyncResume);
}

fn asyncResume(self: [*c]c.JSRTAsync, value: Value, rejected: bool) callconv(.c) void {
    const a: *c.JSRTAsync = self;
    const r = resumeState(a.env, value, if (rejected) c.JSRT_GEN_INJECT_THROW else c.JSRT_GEN_INJECT_NONE);
    if (takeSuspended() != null) return c.jsrt_await(a, r);
    if (rt.pending()) return c.jsrt_async_throw(a, c.jsrt_take_exception());
    c.jsrt_async_return(a, r);
}

// ---- async generators (§27.6)

/// An async generator is the runtime's generator object driven by the machine, not by the
/// runtime's `next`: its `env` is a control environment holding the suspended activation, the
/// queue of requests (§27.6.3.1 AsyncGeneratorRequest, three slots each: mode, value, promise)
/// and the state.
const ag_state = 0;
const ag_queue = 1;
const ag_status = 2;
const ag_size = 3;

const AgStatus = enum(u8) { start, suspended_yield, executing, awaiting_return, completed };

/// What the runtime calls when compiled code drives an async generator as a sync one.
fn agMisuse(_: [*c]c.JSRTGenerator, _: Value) callconv(.c) void {
    rt.throwType("an async generator is not a sync iterator");
}

pub fn isAsyncGenerator(v: Value) bool {
    return c.jsrt_is_generator(v) and genOf(v).@"resume" == &agMisuse;
}

fn genOf(v: Value) *c.JSRTGenerator {
    return @ptrCast(@alignCast(c.jsrt_ptr(v)));
}

fn agControl(g: *c.JSRTGenerator) *Env {
    return g.env;
}

fn agStatus(g: *c.JSRTGenerator) AgStatus {
    return @fromBackingInt(@intCast(intOf(agControl(g).slots()[ag_status])));
}

fn agSetStatus(g: *c.JSRTGenerator, s: AgStatus) void {
    agControl(g).slots()[ag_status] = rt.number(@backingInt(s));
}

fn agStateEnv(g: *c.JSRTGenerator) *Env {
    return unboxPtr(Env, agControl(g).slots()[ag_state]).?;
}

fn startAsyncGenerator(t: *Template, fe: *Env, callee: Value, this: Value, args: []const Value) Value {
    _ = takeSuspended();
    const r = exec(t, fe, .{ .call = .{ .callee = callee, .this = this, .argv = args, .nt = rt.undefined_value } });
    const st = takeSuspended() orelse return r;
    var root: builtins.Frame(3) = .{};
    root.open(.{ boxEnv(st), rt.undefined_value, rt.undefined_value });
    defer root.pop();
    const ctl = c.jsrt_env_new(null, ag_size);
    root.slots[1] = boxEnv(ctl);
    ctl.*.slots()[ag_state] = boxEnv(st);
    ctl.*.slots()[ag_status] = rt.number(@backingInt(AgStatus.start));
    ctl.*.slots()[ag_queue] = c.jsrt_array_new(0, null);
    return c.jsrt_generator_new(ctl, &agMisuse);
}

/// `next`, `return` and `throw` of an async generator (§27.6.1.2–4): a promise, settled when
/// the request reaches the head of the queue and the body answers it.
pub fn agEnqueue(gen: Value, mode: u8, value: Value) Value {
    const promise = c.jsrt_promise_new();
    if (!isAsyncGenerator(gen)) {
        var what: [128]u8 = undefined;
        var buf: [192]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "AsyncGenerator method called on incompatible receiver {s}", .{describe(gen, &what)}) catch "incompatible receiver";
        c.jsrt_promise_settle(promise, c.jsrt_error_new(&c.jsrt_class_type_error, rt.string(msg)), true);
        return promise;
    }
    var root: builtins.Frame(1) = .{};
    root.open(.{promise});
    defer root.pop();
    const g = genOf(gen);
    const q = agControl(g).slots()[ag_queue];
    _ = c.jsrt_array_push(q, rt.number(@floatFromInt(mode)));
    _ = c.jsrt_array_push(q, value);
    _ = c.jsrt_array_push(q, promise);
    const s = agStatus(g);
    if (s != .executing and s != .awaiting_return) agDrain(g);
    return promise;
}

fn agQueue(g: *c.JSRTGenerator) []Value {
    return arrayItems(agControl(g).slots()[ag_queue]);
}

/// Settles the head request's promise and takes it off the queue (§27.6.3.4
/// AsyncGeneratorCompleteStep).
fn agComplete(g: *c.JSRTGenerator, value: Value, done: bool, rejected: bool) void {
    const ctl = agControl(g);
    const promise = arrayItems(ctl.slots()[ag_queue])[2];
    const settled = if (rejected) value else iterResult(value, done);
    c.jsrt_promise_settle(promise, settled, rejected);
    // A new array rather than a shifted one: the environment is the kind whose stores need no
    // write barrier, the array is not.
    const rest = agQueue(g)[3..];
    ctl.slots()[ag_queue] = c.jsrt_array_new(@intCast(rest.len), rest.ptr);
}

/// Answers queued requests until one needs the body to run on or the queue is empty
/// (§27.6.3.9 AsyncGeneratorDrainQueue, with §27.6.3.8 AsyncGeneratorResumeNext's start).
fn agDrain(g: *c.JSRTGenerator) void {
    while (agQueue(g).len > 0) {
        const head = agQueue(g);
        const mode: u8 = @intCast(intOf(head[0]));
        const value = head[1];
        var s = agStatus(g);
        if (s == .start and mode != c.JSRT_GEN_INJECT_NONE) {
            agSetStatus(g, .completed);
            s = .completed;
        }
        if (s == .completed) {
            switch (mode) {
                c.JSRT_GEN_INJECT_NONE => agComplete(g, rt.undefined_value, true, false),
                c.JSRT_GEN_INJECT_THROW => agComplete(g, value, true, true),
                else => {
                    // §27.6.3.10 AsyncGeneratorAwaitReturn.
                    agSetStatus(g, .awaiting_return);
                    const p = c.jsrt_promise_resolve(value);
                    if (rt.pending()) {
                        agSetStatus(g, .completed);
                        agComplete(g, c.jsrt_take_exception(), true, true);
                        continue;
                    }
                    c.jsrt_promise_subscribe(p, &agReturnSettled, g);
                    return;
                },
            }
            continue;
        }
        agSetStatus(g, .executing);
        return agRun(g, value, mode);
    }
}

fn agReturnSettled(state: ?*anyopaque, value: Value, rejected: bool) callconv(.c) void {
    const g: *c.JSRTGenerator = @ptrCast(@alignCast(state.?));
    agSetStatus(g, .completed);
    agComplete(g, value, true, rejected);
    agDrain(g);
}

fn agAwaitSettled(state: ?*anyopaque, value: Value, rejected: bool) callconv(.c) void {
    const g: *c.JSRTGenerator = @ptrCast(@alignCast(state.?));
    agRun(g, value, if (rejected) c.JSRT_GEN_INJECT_THROW else c.JSRT_GEN_INJECT_NONE);
}

/// Runs the body on and answers what it did: an `await` subscribes, a `yield` settles the head
/// request, a completion settles it and ends the generator.
fn agRun(g: *c.JSRTGenerator, sent: Value, mode: u8) void {
    const st = agStateEnv(g);
    const r = resumeState(st, sent, mode);
    if (takeSuspended()) |at| {
        if (stopOf(at) == .await) {
            const p = c.jsrt_promise_resolve(r);
            if (!rt.pending()) return c.jsrt_promise_subscribe(p, &agAwaitSettled, g);
            // A throwing `then` getter would reject the await; resume with the error.
            return agRun(g, c.jsrt_take_exception(), c.JSRT_GEN_INJECT_THROW);
        }
        agSetStatus(g, .suspended_yield);
        agComplete(g, r, false, false);
    } else {
        agSetStatus(g, .completed);
        if (rt.pending()) agComplete(g, c.jsrt_take_exception(), true, true) else agComplete(g, r, true, false);
    }
    agDrain(g);
}

/// `{ value, done }` (§7.4.14 CreateIteratorResultObject).
pub fn iterResult(value: Value, done: bool) Value {
    const o = c.jsrt_dynobj_new();
    defineOwn(o, "value", value);
    defineOwn(o, "done", rt.boolean(done));
    return o;
}

// ---------------------------------------------------------------------- the machine

const Entry = union(enum) {
    call: struct { callee: Value, this: Value, argv: []const Value, nt: Value, state: ?*Env = null },
    resume_: struct { state: *Env, sent: Value, mode: u8 },
};

/// Saves the activation into its state and marks it suspended; the caller returns `value` to
/// the driver.
fn suspendAt(state: *?*Env, w: []Value, nlocals: usize, depth: usize, pc: usize, env: ?*Env, stop: Stop) void {
    const st: *Env = state.* orelse blk: {
        const e: *Env = c.jsrt_env_new(env, @intCast(st_window + w.len));
        e.*.slots()[st_running] = rt.false_value;
        state.* = e;
        break :blk e;
    };
    st.parent = env;
    const s = st.slots();
    s[st_pc] = rt.number(@floatFromInt(pc));
    s[st_depth] = rt.number(@floatFromInt(depth));
    s[st_stop] = rt.number(@backingInt(stop));
    const used = header + nlocals + depth;
    @memcpy(s[st_window..][0..used], w[0..used]);
    @memset(s[st_window + used .. st_window + w.len], rt.undefined_value);
    suspended = st;
}

fn exec(t: *Template, fe: ?*Env, entry: Entry) Value {
    if (stackExhausted()) return c.jsrt_stack_overflow();
    const mach = thisMachine();
    const vs = mach.stack;
    const base = mach.sp;
    const window = windowSize(t);
    if (base + window > vs.len) {
        rt.throwRange("Maximum call stack size exceeded");
        return rt.undefined_value;
    }
    mach.sp = base + window;
    defer mach.sp = base;
    const w = vs[base .. base + window];
    @memset(w, rt.undefined_value);
    const locals = w[header .. header + t.nlocals];
    const op_base = base + header + t.nlocals;
    var frame: c.JSRTFrame = .{ .prev = c.jsrt_frame_top, .count = @intCast(window), .slots = w.ptr, .env = if (fe) |e| e.parent else null };
    c.jsrt_frame_top = &frame;
    defer c.jsrt_frame_top = frame.prev;

    const code = t.code;
    var pc: usize = 0;
    var top: usize = op_base;
    var argv: []const Value = &.{};
    var state: ?*Env = null;
    switch (entry) {
        .call => |e| {
            w[0] = e.callee;
            w[1] = e.this;
            w[2] = e.nt;
            argv = e.argv;
            state = e.state;
        },
        .resume_ => |r| {
            state = r.state;
            const s = r.state.slots();
            const depth = intOf(s[st_depth]);
            @memcpy(w[0 .. header + t.nlocals + depth], s[st_window..][0 .. header + t.nlocals + depth]);
            pc = intOf(s[st_pc]);
            top = op_base + depth;
            frame.env = r.state.parent;
            switch (stopOf(r.state)) {
                .call, .start => {},
                .yield => {
                    push(vs, &top, r.sent);
                    push(vs, &top, rt.number(@floatFromInt(r.mode)));
                },
                .await => if (r.mode == c.JSRT_GEN_INJECT_THROW) {
                    c.jsrt_throw(r.sent);
                    // The rejection is thrown at the `await` itself.
                    const h = findHandler(t, pc - 1) orelse return rt.undefined_value;
                    const exc = c.jsrt_take_exception();
                    top = op_base;
                    frame.env = unboxPtr(Env, locals[h.env_local]);
                    push(vs, &top, exc);
                    pc = h.target;
                } else push(vs, &top, r.sent),
            }
        },
    }

    if (entry == .call and state == null) if (jit.codeFor(t)) |native| {
        if (builtin.is_test) jit.entries += 1;
        const st: jit.Stack = .{ .sp = &mach.sp, .top = &c.jsrt_frame_top, .values = vs, .limit = c.jsrt_stack_limit, .pending = mach.pending };
        return jit.enter(native, t, fe, w.ptr, argv, &frame, &st);
    };
    // Read in place after every instruction: jsrt_pending() would cost a call and a thread-local
    // lookup each time.
    const pending = mach.pending;

    while (true) {
        const at = pc;
        const o: Op = @fromBackingInt(@intCast(next8(code, &pc)));
        switch (o) {
            .undef => push(vs, &top, rt.undefined_value),
            .null => push(vs, &top, rt.null_value),
            .true => push(vs, &top, rt.true_value),
            .false => push(vs, &top, rt.false_value),
            .uninit => push(vs, &top, rt.uninitialized),
            .int => {
                const v: i32 = @bitCast(next32(code, &pc));
                push(vs, &top, rt.number(@floatFromInt(v)));
            },
            .num => push(vs, &top, rt.number(t.numbers[next16(code, &pc)])),
            .str => push(vs, &top, rt.string(t.strings[next16(code, &pc)])),
            .pop => top -= 1,
            .dup => push(vs, &top, vs[top - 1]),
            .dup2 => {
                vs[top] = vs[top - 2];
                vs[top + 1] = vs[top - 1];
                top += 2;
            },
            .swap => std.mem.swap(Value, &vs[top - 1], &vs[top - 2]),
            // The top value sinks under the next two or three.
            .insert3, .insert4 => {
                const n: usize = if (o == .insert3) 3 else 4;
                std.mem.rotate(Value, vs[top - n .. top], n - 1);
            },

            .load => {
                push(vs, &top, locals[next16(code, &pc)]);
            },
            .store => {
                top -= 1;
                locals[next16(code, &pc)] = vs[top];
            },
            .load_checked => {
                const v = locals[next16(code, &pc)];
                const name = t.keys[next16(code, &pc)];
                if (v == rt.uninitialized) tdzError(name) else push(vs, &top, v);
            },
            .store_checked => {
                const slot = next16(code, &pc);
                const name = t.keys[next16(code, &pc)];
                top -= 1;
                if (locals[slot] == rt.uninitialized) tdzError(name) else locals[slot] = vs[top];
            },
            .load_env, .load_env_checked, .store_env, .store_env_checked => {
                const hops = next8(code, &pc);
                const slot = next16(code, &pc);
                const checked = o == .load_env_checked or o == .store_env_checked;
                const name: ?[*:0]const u8 = if (checked) t.keys[next16(code, &pc)] else null;
                if (o == .load_env or o == .load_env_checked) push(vs, &top, envLoad(frame.env, hops, slot, name)) else {
                    top -= 1;
                    envStore(frame.env, hops, slot, name, vs[top]);
                }
            },
            .load_ref, .store_ref => {
                const e = outward(frame.env, next8(code, &pc));
                const cell = unboxPtr(Value, e.slots()[next16(code, &pc)]).?;
                if (o == .load_ref) push(vs, &top, cell.*) else {
                    top -= 1;
                    cell.* = vs[top];
                }
            },
            .load_global, .typeof_global => push(vs, &top, loadGlobal(t, next16(code, &pc), o == .typeof_global)),
            .store_global => {
                top -= 1;
                // Operands decode left to right: the key, then the strict flag.
                storeGlobal(t, next16(code, &pc), next8(code, &pc) != 0, vs[top]);
            },
            .delete_global => {
                const k = t.keys[next16(code, &pc)];
                push(vs, &top, rt.boolean(c.jsrt_delete(builtins.global(), rt.string(keyText(k)))));
            },
            .declare_global => declareGlobal(t.keys[next16(code, &pc)]),
            .push_env => {
                frame.env = c.jsrt_env_new(frame.env, next16(code, &pc));
            },
            .pop_env => frame.env = frame.env.*.parent,
            .clone_env => frame.env = c.jsrt_env_clone(frame.env),
            // Boxed as a reference so a suspended activation's saved copy keeps it alive.
            .save_env => {
                locals[next16(code, &pc)] = boxEnv(frame.env);
            },
            .const_assign => {
                pc += 2;
                rt.throwType("Assignment to constant variable.");
            },
            .assert_uninit => {
                top -= 1;
                if (vs[top] != rt.uninitialized) rt.throwReference("Super constructor may only be called once");
            },

            .arg => {
                const i = next16(code, &pc);
                push(vs, &top, if (i < argv.len) argv[i] else rt.undefined_value);
            },
            .rest => push(vs, &top, newArray(argv[@min(next16(code, &pc), argv.len)..])),
            .arguments => push(vs, &top, newArray(argv)),
            .this_raw => push(vs, &top, w[1]),
            .this_sloppy => push(vs, &top, sloppyThis(w[1])),
            .new_target => push(vs, &top, w[2]),
            .callee => push(vs, &top, w[0]),
            .home => push(vs, &top, homeOf(fe)),

            .get_prop => {
                const site = nextSite(t, code, &pc);
                vs[top - 1] = getProp(vs[top - 1], site.key, site.ic);
            },
            .set_prop => {
                const site = nextSite(t, code, &pc);
                const v = vs[top - 1];
                top -= 1;
                setProp(vs[top - 1], site.key, v, site.ic);
                vs[top - 1] = v;
            },
            .get_elem => binop(vs, &top, getElem),
            .set_elem => {
                const v = vs[top - 1];
                top -= 2;
                setElem(vs[top - 1], vs[top], v);
                vs[top - 1] = v;
            },
            .delete_prop => {
                const k = t.keys[next16(code, &pc)];
                vs[top - 1] = deleteKey(vs[top - 1], rt.string(keyText(k)));
            },
            .delete_elem => binop(vs, &top, deleteKey),
            .in => {
                top -= 1;
                const obj = vs[top];
                vs[top - 1] = if (!rt.isObjectLike(obj))
                    throwAbout(obj, "Cannot use 'in' operator to search for a key in {s}")
                else
                    rt.boolean(c.jsrt_in(toKey(vs[top - 1]), obj));
            },
            .instanceof => binop(vs, &top, instanceOfValue),
            .super_get => {
                const k = t.keys[next16(code, &pc)];
                top -= 1;
                const proto = protoOf(vs[top - 1]);
                vs[top - 1] = if (c.jsrt_is_nullish(proto)) rt.undefined_value else getProp(proto, k, null);
            },
            .super_get_elem => {
                top -= 2;
                const proto = protoOf(vs[top - 1]);
                vs[top - 1] = if (c.jsrt_is_nullish(proto)) rt.undefined_value else getElem(proto, vs[top + 1]);
            },

            .add, .bitand, .bitor, .bitxor, .shl, .shr, .ushr, .sub, .mul, .div, .mod, .exp, .eq, .ne, .seq, .sne, .lt, .gt, .le, .ge => {
                top -= 1;
                const a = vs[top - 1];
                const b = vs[top];
                // Arithmetic on two numbers cannot throw, so it skips the exception check.
                if (c.jsrt_is_number(a) and c.jsrt_is_number(b)) if (numeric(o, c.jsrt_number_value(a), c.jsrt_number_value(b))) |r| {
                    vs[top - 1] = r;
                    continue;
                };
                vs[top - 1] = binary(o, a, b);
            },
            .neg, .plus, .bitnot, .not, .typeof, .inc, .dec => vs[top - 1] = unary(o, vs[top - 1]),
            .to_string => vs[top - 1] = c.jsrt_to_string(vs[top - 1]),
            .to_key => vs[top - 1] = toKey(vs[top - 1]),

            .jump => pc = bc.read32(code, pc),
            .jump_if_false, .jump_if_true, .jump_if_nullish, .jump_if_not_undef => {
                top -= 1;
                const v = vs[top];
                const taken = switch (o) {
                    .jump_if_false => !truthy(v),
                    .jump_if_true => truthy(v),
                    .jump_if_nullish => c.jsrt_is_nullish(v),
                    else => v != rt.undefined_value,
                };
                pc = if (taken) bc.read32(code, pc) else pc + 4;
            },
            .jump_if_int => {
                const want: i32 = @bitCast(next32(code, &pc));
                const target = next32(code, &pc);
                top -= 1;
                if (c.jsrt_to_number(vs[top]) == @as(f64, @floatFromInt(want))) pc = target;
            },

            .call => {
                const argc = next16(code, &pc);
                const args = vs[top - argc .. top];
                const r = call(vs[top - argc - 2], vs[top - argc - 1], args);
                top -= argc + 1;
                vs[top - 1] = r;
            },
            .call_spread => {
                const r = call(vs[top - 3], vs[top - 2], arrayItems(vs[top - 1]));
                top -= 2;
                vs[top - 1] = r;
            },
            .new => {
                const argc = next16(code, &pc);
                const ctor = vs[top - argc - 1];
                const r = construct(ctor, vs[top - argc .. top], ctor);
                top -= argc;
                vs[top - 1] = r;
            },
            .new_spread => {
                const ctor = vs[top - 2];
                const r = construct(ctor, arrayItems(vs[top - 1]), ctor);
                top -= 1;
                vs[top - 1] = r;
            },
            .super_call, .super_call_spread => {
                var argc: usize = 1;
                var args: []const Value = undefined;
                if (o == .super_call) {
                    argc = next16(code, &pc);
                    args = vs[top - argc .. top];
                } else args = arrayItems(vs[top - 1]);
                const f = vs[top - argc - 2];
                const target = vs[top - argc - 1];
                // `super()` outside a derived constructor is an early error the compiler leaves
                // to here when it reaches the VM through eval code (§19.2.1.1).
                const parent = if (isInterpreted(f)) fnEnv(f).slots()[compile.fnenv_parent] else rt.undefined_value;
                const r = if (!isInterpreted(f)) blk: {
                    rt.throwSyntax("'super' keyword unexpected here");
                    break :blk rt.undefined_value;
                } else if (!isConstructor(parent)) blk: {
                    rt.throwType("Super constructor is not a constructor");
                    break :blk rt.undefined_value;
                } else construct(parent, args, target);
                top -= argc + 1;
                vs[top - 1] = r;
            },
            .ret => {
                top -= 1;
                return vs[top];
            },
            .ret_ctor => {
                top -= 2;
                const r = ctorReturn(t, w[2], vs[top], vs[top + 1]);
                if (!rt.pending()) return r;
            },
            .throw => {
                top -= 1;
                c.jsrt_throw(vs[top]);
            },
            .throw_error => {
                const k = t.keys[next16(code, &pc)];
                c.jsrt_throw_error(&c.jsrt_class_type_error, k);
            },

            .new_object => push(vs, &top, c.jsrt_dynobj_new()),
            .new_array => {
                const n = next16(code, &pc);
                const arr = newArray(vs[top - n .. top]);
                top -= n;
                push(vs, &top, arr);
            },
            .array_push => {
                top -= 1;
                _ = c.jsrt_array_push(vs[top - 1], vs[top]);
            },
            .array_hole => _ = c.jsrt_array_push(vs[top - 1], c.JSRT_HOLE),
            .array_spread => {
                vs[top - 1] = getIterator(vs[top - 1]);
                if (!rt.pending()) {
                    var v: Value = undefined;
                    while (iterStep(vs[top - 1], &v)) _ = c.jsrt_array_push(vs[top - 2], v);
                }
                top -= 1;
            },
            .define => {
                const k = t.keys[next16(code, &pc)];
                top -= 1;
                defineOwn(vs[top - 1], k, vs[top]);
            },
            .define_elem => {
                top -= 2;
                defineOwn(vs[top - 1], keyOf(vs[top]), vs[top + 1]);
            },
            .define_accessor => {
                const k = t.keys[next16(code, &pc)];
                const setter = next8(code, &pc) != 0;
                top -= 1;
                defineAccessor(vs[top - 1], k, vs[top], setter);
            },
            .define_accessor_elem => {
                const setter = next8(code, &pc) != 0;
                top -= 2;
                defineAccessor(vs[top - 1], keyOf(vs[top]), vs[top + 1], setter);
            },
            .object_spread => {
                top -= 1;
                copyDataProperties(vs[top - 1], vs[top]);
            },
            .set_proto => {
                top -= 1;
                const p = vs[top];
                const obj = vs[top - 1];
                if (rt.isObjectLike(p)) {
                    dynObj(obj).proto = p;
                } else if (p == rt.null_value) {
                    dynObj(obj).cls = &c.jsrt_class_null_proto;
                }
            },
            .closure => {
                const f = makeClosure(t.funcs[next16(code, &pc)], frame.env);
                push(vs, &top, f);
            },
            .set_home => {
                const d = next8(code, &pc);
                fnEnv(vs[top - 1]).slots()[compile.fnenv_home] = vs[top - 1 - d];
            },
            .class_setup => {
                const has = next8(code, &pc) != 0;
                if (classSetup(vs[top - 2], vs[top - 1], has)) |proto| {
                    vs[top - 2] = vs[top - 1];
                    vs[top - 1] = proto;
                }
            },
            .set_field_init => {
                top -= 1;
                fnEnv(vs[top - 1]).slots()[compile.fnenv_fields] = vs[top];
            },
            .run_field_init => {
                top -= 2;
                const f = vs[top];
                if (isInterpreted(f)) {
                    const init = fnEnv(f).slots()[compile.fnenv_fields];
                    if (isInterpreted(init)) _ = call(init, vs[top + 1], &.{});
                }
            },
            .regexp => {
                const s = t.strings[next16(code, &pc)];
                const flags = t.strings[next16(code, &pc)];
                // The flags string is made first and kept on the stack while the source is.
                push(vs, &top, rt.string(flags));
                vs[top - 1] = c.jsrt_regexp_new(rt.string(s), vs[top - 1]);
            },
            .tagged_template => {
                const n = next16(code, &pc);
                const strings = vs[top - n - 1];
                c.jsrt_set_prop(strings, "raw", strings, null);
                const r = call(vs[top - n - 3], vs[top - n - 2], vs[top - n - 1 .. top]);
                top -= n + 2;
                vs[top - 1] = r;
            },

            .get_iterator, .get_async_iterator => vs[top - 1] = if (o == .get_iterator) getIterator(vs[top - 1]) else getAsyncIterator(vs[top - 1]),
            .iter_next => {
                const target = next32(code, &pc);
                var v: Value = rt.undefined_value;
                if (iterStep(vs[top - 1], &v)) {
                    vs[top - 1] = v;
                } else {
                    top -= 1;
                    if (!rt.pending()) pc = target;
                }
            },
            .iter_value => {
                var v: Value = rt.undefined_value;
                if (!iterStep(vs[top - 1], &v)) v = rt.undefined_value;
                push(vs, &top, v);
            },
            .iter_rest => {
                push(vs, &top, c.jsrt_array_new(0, null));
                var v: Value = undefined;
                while (iterStep(vs[top - 2], &v)) _ = c.jsrt_array_push(vs[top - 1], v);
                vs[top - 2] = vs[top - 1];
                top -= 1;
            },
            .iter_close => {
                top -= 1;
                iterClose(vs[top]);
            },
            .iter_close_quiet => {
                top -= 1;
                iterClose(vs[top]);
                if (rt.pending()) _ = c.jsrt_take_exception();
            },
            .for_in_keys => vs[top - 1] = if (c.jsrt_is_nullish(vs[top - 1])) c.jsrt_array_new(0, null) else c.jsrt_object_for_in_keys(vs[top - 1]),
            .for_in_next => {
                const keys = locals[next16(code, &pc)];
                const idx_slot = next16(code, &pc);
                const target = next32(code, &pc);
                const items = arrayItems(keys);
                const i: usize = @intFromFloat(c.jsrt_to_number(locals[idx_slot]));
                if (i >= items.len) {
                    pc = target;
                } else {
                    locals[idx_slot] = rt.number(@floatFromInt(i + 1));
                    push(vs, &top, items[i]);
                }
            },
            .debugger => {},

            .gen_start => {
                suspendAt(&state, w, t.nlocals, top - op_base, pc, frame.env, .start);
                return rt.undefined_value;
            },
            .yield, .await => {
                const v = vs[top - 1];
                top -= 1;
                suspendAt(&state, w, t.nlocals, top - op_base, pc, frame.env, if (o == .yield) .yield else .await);
                return v;
            },
            .reset_stack => top = op_base,
            // Both leave `rec value kind`: `delegate` from `rec received mode`, the async step
            // from `rec mode settled`.
            .delegate, .async_delegate_step => {
                var v: Value = rt.undefined_value;
                const kind = if (o == .delegate)
                    delegateStep(vs[top - 3], vs[top - 2], @intCast(intOf(vs[top - 1])), &v)
                else
                    asyncDelegateResult(vs[top - 3], vs[top - 1], @intCast(intOf(vs[top - 2])), &v);
                vs[top - 2] = v;
                vs[top - 1] = rt.number(@floatFromInt(kind));
            },
            .async_delegate => {
                var mode: u8 = @intCast(intOf(vs[top - 1]));
                const r = asyncDelegateCall(vs[top - 3], vs[top - 2], &mode);
                vs[top - 2] = rt.number(@floatFromInt(mode));
                vs[top - 1] = r;
            },
            .async_iter_next => {
                const s = recSlots(vs[top - 1]);
                if (s[rec_wrapped] == rt.true_value) {
                    var v: Value = rt.undefined_value;
                    const more = iterStep(s[rec_iter], &v);
                    if (!more and !rt.pending()) s[rec_done] = rt.true_value;
                    vs[top - 1] = v;
                } else vs[top - 1] = call(s[rec_next], s[rec_iter], &.{});
            },
            .async_iter_step => {
                const target = next32(code, &pc);
                const y = vs[top - 1];
                const s = recSlots(vs[top - 2]);
                top -= 2;
                if (s[rec_wrapped] == rt.true_value) {
                    if (s[rec_done] == rt.true_value) pc = target else push(vs, &top, y);
                } else if (!rt.isObjectLike(y)) {
                    _ = throwAbout(y, "Iterator result {s} is not an object");
                } else {
                    const done = getProp(y, "done", null);
                    if (!rt.pending()) {
                        if (c.jsrt_truthy(done)) {
                            s[rec_done] = rt.true_value;
                            pc = target;
                        } else push(vs, &top, getProp(y, "value", null));
                    }
                }
            },
            .async_close_call => {
                const target = next32(code, &pc);
                const s = recSlots(vs[top - 1]);
                if (s[rec_wrapped] == rt.true_value or s[rec_done] == rt.true_value) {
                    if (s[rec_wrapped] == rt.true_value) iterClose(s[rec_iter]);
                    top -= 1;
                    if (!rt.pending()) pc = target;
                } else {
                    s[rec_done] = rt.true_value;
                    const m = getProp(s[rec_iter], "return", null);
                    if (!rt.pending()) {
                        if (c.jsrt_is_nullish(m)) {
                            top -= 1;
                            pc = target;
                        } else vs[top - 1] = call(m, s[rec_iter], &.{});
                    }
                }
            },
            .async_close_check => {
                top -= 1;
                if (!rt.isObjectLike(vs[top])) _ = throwAbout(vs[top], "Iterator result {s} is not an object");
            },
        }
        if (pending.*) {
            const h = findHandler(t, at) orelse return rt.undefined_value;
            const exc = c.jsrt_take_exception();
            top = op_base;
            frame.env = unboxPtr(Env, locals[h.env_local]);
            push(vs, &top, exc);
            pc = h.target;
        }
    }
}

/// Reads the operand at `pc.*` and steps past it.
fn next8(code: []const u8, pc: *usize) u8 {
    defer pc.* += 1;
    return code[pc.*];
}

fn next16(code: []const u8, pc: *usize) u16 {
    defer pc.* += 2;
    return bc.read16(code, pc.*);
}

/// A named property site: its key, then its inline cache.
const Site = struct { key: [*:0]const u8, ic: *c.JSRTIC };

fn nextSite(t: *Template, code: []const u8, pc: *usize) Site {
    const key = t.keys[next16(code, pc)];
    return .{ .key = key, .ic = &t.ics[next16(code, pc)] };
}

fn next32(code: []const u8, pc: *usize) u32 {
    defer pc.* += 4;
    return bc.read32(code, pc.*);
}

fn push(vs: []Value, top: *usize, v: Value) void {
    vs[top.*] = v;
    top.* += 1;
}

/// A binary operator's semantics: the dispatch loop's, and the JIT's slow path (src/jit/).
pub fn binary(o: Op, a: Value, b: Value) Value {
    if (c.jsrt_is_number(a) and c.jsrt_is_number(b)) if (numeric(o, c.jsrt_number_value(a), c.jsrt_number_value(b))) |r| return r;
    return switch (o) {
        inline .add, .bitand, .bitor, .bitxor, .shl, .shr, .ushr => |op| @field(c, "jsrt_op_" ++ @tagName(op))(a, b),
        .exp => c.jsrt_math_pow(a, b),
        .sub, .mul, .div, .mod => blk: {
            const x = c.jsrt_to_number(a);
            const y = if (rt.pending()) 0 else c.jsrt_to_number(b);
            break :blk rt.number(switch (o) {
                .sub => x - y,
                .mul => x * y,
                .div => x / y,
                else => jsMod(x, y),
            });
        },
        .eq => rt.boolean(c.jsrt_loose_equals(a, b)),
        .ne => rt.boolean(!c.jsrt_loose_equals(a, b)),
        .seq => rt.boolean(c.jsrt_strict_equals(a, b)),
        .sne => rt.boolean(!c.jsrt_strict_equals(a, b)),
        .lt => rt.boolean(c.jsrt_op_lt(a, b)),
        .gt => rt.boolean(c.jsrt_op_gt(a, b)),
        .le => rt.boolean(c.jsrt_op_le(a, b)),
        .ge => rt.boolean(c.jsrt_op_ge(a, b)),
        else => unreachable,
    };
}

/// Two numbers need no coercion, so the operator is the IEEE operation itself; null leaves the
/// bitwise operators and `**` to the runtime, whose ToInt32 and pow are the specified ones.
inline fn numeric(o: Op, x: f64, y: f64) ?Value {
    return switch (o) {
        .add => rt.number(x + y),
        .sub => rt.number(x - y),
        .mul => rt.number(x * y),
        .div => rt.number(x / y),
        .mod => rt.number(jsMod(x, y)),
        .eq, .seq => rt.boolean(x == y),
        .ne, .sne => rt.boolean(x != y),
        .lt => rt.boolean(x < y),
        .gt => rt.boolean(x > y),
        .le => rt.boolean(x <= y),
        .ge => rt.boolean(x >= y),
        else => null,
    };
}

/// A unary operator's semantics, shared the same way.
pub fn unary(o: Op, v: Value) Value {
    if (c.jsrt_is_number(v)) {
        const x = c.jsrt_number_value(v);
        switch (o) {
            .inc => return rt.number(x + 1),
            .dec => return rt.number(x - 1),
            .neg => return rt.number(-x),
            .plus => return v,
            else => {},
        }
    }
    return switch (o) {
        .neg => rt.number(-c.jsrt_to_number(v)),
        .plus => rt.number(c.jsrt_to_number(v)),
        .bitnot => c.jsrt_op_bitnot(v),
        .not => rt.boolean(!c.jsrt_truthy(v)),
        .typeof => c.jsrt_typeof(v),
        .inc => rt.number(c.jsrt_to_number(v) + 1),
        .dec => rt.number(c.jsrt_to_number(v) - 1),
        else => unreachable,
    };
}

/// A global name's value (`typeof_` answers its `typeof` instead, never a ReferenceError). The
/// key's cache, `t.global_ics[ki]`, is the one the JIT's inline read checks too.
pub fn loadGlobal(t: *Template, ki: u16, typeof_: bool) Value {
    if (cachedGlobal(t, ki)) |slot| return if (typeof_) c.jsrt_typeof(slot.*) else slot.*;
    const k = t.keys[ki];
    const g = builtins.global();
    if (!c.jsrt_has_prop(g, k)) {
        if (typeof_) return rt.string("undefined");
        throwFmt(&c.jsrt_class_reference_error, "{s} is not defined", .{keyText(k)});
        return rt.undefined_value;
    }
    const v = c.jsrt_get_prop(g, k, null);
    return if (typeof_) c.jsrt_typeof(v) else v;
}

/// What a construction answers (§10.2.2 [[Construct]] steps 10–12): `nt` is new.target, `v`
/// the returned value; undefined with an exception pending when the return is an error.
pub fn ctorReturn(t: *const Template, nt: Value, v: Value, this: Value) Value {
    if (nt == rt.undefined_value or rt.isObjectLike(v)) return v;
    if (t.kind == .derived_ctor and v != rt.undefined_value) {
        rt.throwType("Derived constructors may only return object or undefined");
    } else if (this == rt.uninitialized) {
        rt.throwReference("Must call super constructor in derived class before accessing 'this' or returning from derived constructor");
    } else return this;
    return rt.undefined_value;
}

/// The function's home object (methods): `super.x` starts at its prototype.
pub fn homeOf(fe: ?*Env) Value {
    return if (fe) |e| e.slots()[compile.fnenv_home] else rt.undefined_value;
}

/// `this` as a sloppy function sees it: the global object for undefined or null.
fn sloppyThis(v: Value) Value {
    return if (c.jsrt_is_nullish(v)) builtins.global() else v;
}

pub fn storeGlobal(t: *Template, ki: u16, strict: bool, v: Value) void {
    const g = builtins.global();
    if (!dynObj(g).frozen) if (cachedGlobal(t, ki)) |slot| return writeSlot(dynObj(g), slot, v);
    const k = t.keys[ki];
    if (strict and !c.jsrt_has_prop(g, k)) throwFmt(&c.jsrt_class_reference_error, "{s} is not defined", .{keyText(k)}) else c.jsrt_set_prop(g, k, v, null);
}

/// The global object's own data slot for `t`'s key `ki`: the key's cache, refilled by one shape
/// walk when the object's shape has moved on (a global added or deleted). What the runtime's
/// has-then-get would find for an own data property; anything else returns null for that path.
fn cachedGlobal(t: *Template, ki: u16) ?*Value {
    const o = dynObj(builtins.global());
    const ic = &t.global_ics[ki];
    if (ic.shape != @as(?*const c.JSRTShape, o.shape)) {
        const hit = c.jsrt_shape_find(o.shape, t.keys[ki]) orelse return null;
        ic.* = .{ .shape = o.shape, .offset = hit.*.offset };
    }
    return cachedSlot(o, t.keys[ki], ic);
}

/// A global `var` or function's property, made undefined when the object lacks it.
pub fn declareGlobal(k: [*:0]const u8) void {
    const g = builtins.global();
    if (!c.jsrt_has_prop(g, k)) c.jsrt_set_prop(g, k, rt.undefined_value, null);
}

pub fn newArray(items: []const Value) Value {
    return c.jsrt_array_new(@intCast(items.len), items.ptr);
}

/// A binding `hops` scopes out; `name` is set when a read must check the TDZ.
pub fn envLoad(env: *Env, hops: u8, slot: u16, name: ?[*:0]const u8) Value {
    const v = outward(env, hops).slots()[slot];
    if (name) |n| if (v == rt.uninitialized) {
        tdzError(n);
        return rt.undefined_value;
    };
    return v;
}

pub fn envStore(env: *Env, hops: u8, slot: u16, name: ?[*:0]const u8, v: Value) void {
    const cell = &outward(env, hops).slots()[slot];
    if (name) |n| if (cell.* == rt.uninitialized) return tdzError(n);
    cell.* = v;
}

/// ToBoolean, with the booleans comparisons push answered without the runtime call.
fn truthy(v: Value) bool {
    if (v == rt.true_value) return true;
    if (v == rt.false_value) return false;
    return c.jsrt_truthy(v);
}

fn binop(vs: []Value, top: *usize, comptime f: anytype) void {
    top.* -= 1;
    vs[top.* - 1] = f(vs[top.* - 1], vs[top.*]);
}

fn instanceOfValue(v: Value, target: Value) Value {
    return rt.boolean(instanceOf(v, target));
}

fn jsMod(a: f64, b: f64) f64 {
    // Integers below 2^53 are exact in both representations, so the integer remainder is the
    // float one without fmod; only a zero result needs the dividend's sign put back.
    const exact = 9007199254740992.0;
    if (@abs(a) < exact and @abs(b) < exact and b != 0 and @trunc(a) == a and @trunc(b) == b) {
        const r = @rem(@as(i64, @intFromFloat(a)), @as(i64, @intFromFloat(b)));
        return if (r == 0) std.math.copysign(@as(f64, 0), a) else @floatFromInt(r);
    }
    if (std.math.isInf(b) and std.math.isFinite(a)) return a;
    if (b == 0 or std.math.isNan(a) or std.math.isNan(b) or std.math.isInf(a)) return std.math.nan(f64);
    const r = @rem(a, b);
    // The result takes the dividend's sign, -0 included.
    return if (r == 0) std.math.copysign(@as(f64, 0), a) else r;
}

fn deleteKey(obj: Value, key: Value) Value {
    if (!rt.coercible(obj)) return rt.undefined_value;
    if (!rt.isObjectLike(obj)) return rt.true_value;
    return rt.boolean(c.jsrt_delete(ownTable(obj), key));
}

pub fn tdzError(name: [*:0]const u8) void {
    const n = keyText(name);
    if (std.mem.eql(u8, n, "%this")) {
        rt.throwReference("Must call super constructor in derived class before accessing 'this' or returning from derived constructor");
    } else throwFmt(&c.jsrt_class_reference_error, "Cannot access '{s}' before initialization", .{n});
}

fn findHandler(t: *Template, pc: usize) ?bc.Handler {
    for (t.handlers) |h| if (pc >= h.start and pc < h.end) return h;
    return null;
}
