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
const Value = rt.Value;
const Op = bc.Op;
const Template = bc.Template;
const Env = c.JSRTEnv;

const stack_values = 1 << 20;
threadlocal var stack: []Value = &.{};
threadlocal var sp: usize = 0;

fn valueStack() []Value {
    if (stack.len == 0) {
        stack = std.heap.page_allocator.alloc(Value, stack_values) catch @panic("out of memory");
        @memset(stack, rt.undefined_value);
    }
    return stack;
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
    return run(t, fe, callee, this, args, rt.undefined_value);
}

/// Calls any value with a receiver; a non-function is the TypeError Node raises.
pub fn call(callee: Value, this: Value, args: []const Value) Value {
    if (!rt.is(callee, c.JSRT_TAG_CLOSURE)) return throwAbout(callee, "{s} is not a function");
    if (isInterpreted(callee)) return callInterpreted(fnEnv(callee), callee, this, args);
    return c.jsrt_call_with_this(callee, this, @intCast(args.len), args.ptr);
}

pub fn isConstructor(v: Value) bool {
    if (!rt.is(v, c.JSRT_TAG_CLOSURE)) return false;
    if (isInterpreted(v)) return templateOf(fnEnv(v)).kind.constructible();
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
    if (c.jsrt_is_error(obj) and std.mem.eql(u8, keyText(key), "constructor")) return builtins.errorConstructorOf(obj);
    if (rt.is(obj, c.JSRT_TAG_CLOSURE)) return closureGet(obj, key);
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

fn setProp(obj: Value, key: [*:0]const u8, v: Value, ic: ?*c.JSRTIC) void {
    if (c.jsrt_is_nullish(obj)) {
        throwFmt(&c.jsrt_class_type_error, "Cannot set properties of {s} (setting '{s}')", .{ if (obj == rt.null_value) "null" else "undefined", keyText(key) });
        return;
    }
    if (!rt.isObjectLike(obj)) return; // a primitive's property write is dropped
    c.jsrt_set_prop(obj, key, v, ic);
}

pub fn getElem(obj: Value, k: Value) Value {
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

fn setElem(obj: Value, k: Value, v: Value) void {
    if (c.jsrt_is_nullish(obj)) {
        var buf: [128]u8 = undefined;
        throwFmt(&c.jsrt_class_type_error, "Cannot set properties of {s} (setting '{s}')", .{ if (obj == rt.null_value) "null" else "undefined", describe(k, &buf) });
        return;
    }
    if (!rt.isObjectLike(obj)) return;
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

fn recSlots(rec: Value) [*]Value {
    const arr: *c.JSRTArray = @ptrCast(@alignCast(c.jsrt_ptr(rec)));
    return arr.elements;
}

const iterator_key = "__@iterator";

pub fn getIterator(v: Value) Value {
    var items = [3]Value{ rt.undefined_value, rt.undefined_value, rt.false_value };
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
    if (c.jsrt_is_nullish(v) or !rt.isObjectLike(v) and !rt.is(v, c.JSRT_TAG_STRING)) {
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

pub fn arrayItems(arr: Value) []Value {
    const a: *c.JSRTArray = @ptrCast(@alignCast(c.jsrt_ptr(arr)));
    return a.elements[0..a.length];
}

// ---------------------------------------------------------------------- closures and classes

fn makeClosure(t: *Template, scope: ?*Env) Value {
    const fe = c.jsrt_env_new(scope, compile.fnenv_size);
    fe.*.slots()[compile.fnenv_template] = boxPtr(t);
    // No allocation between making the closure and storing it: a boxed value in a Zig local is
    // not a root.
    const f = c.jsrt_closure_new(&trampoline, t.arity, t.name, fe, true);
    fe.*.slots()[compile.fnenv_self] = f;
    if (t.kind == .function) _ = c.jsrt_closure_constructible(f);
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

/// Runs one activation of `t`. `fe` is the closure's environment (null for a script).
pub fn run(t: *Template, fe: ?*Env, callee: Value, this_in: Value, argv: []const Value, nt: Value) Value {
    if (stackExhausted()) return c.jsrt_stack_overflow();
    const vs = valueStack();
    const base = sp;
    const window = 3 + t.nlocals + t.max_stack;
    if (base + window > vs.len) {
        rt.throwRange("Maximum call stack size exceeded");
        return rt.undefined_value;
    }
    sp = base + window;
    defer sp = base;
    const w = vs[base .. base + window];
    @memset(w, rt.undefined_value);
    w[0] = callee;
    w[1] = this_in;
    w[2] = nt;
    const locals = w[3 .. 3 + t.nlocals];
    const op_base = base + 3 + t.nlocals;
    var frame: c.JSRTFrame = .{ .prev = c.jsrt_frame_top, .count = @intCast(window), .slots = w.ptr, .env = if (fe) |e| e.parent else null };
    c.jsrt_frame_top = &frame;
    defer c.jsrt_frame_top = frame.prev;

    const code = t.code;
    var pc: usize = 0;
    var top: usize = op_base;

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
                var e: *Env = frame.env;
                var hops = next8(code, &pc);
                while (hops > 0) : (hops -= 1) e = e.parent;
                const slot = next16(code, &pc);
                const checked = o == .load_env_checked or o == .store_env_checked;
                const name: [*:0]const u8 = if (checked) t.keys[next16(code, &pc)] else "";
                const cell = &e.slots()[slot];
                if (o == .load_env or o == .load_env_checked) {
                    if (checked and cell.* == rt.uninitialized) tdzError(name) else push(vs, &top, cell.*);
                } else {
                    top -= 1;
                    if (checked and cell.* == rt.uninitialized) tdzError(name) else cell.* = vs[top];
                }
            },
            .load_global, .typeof_global => {
                const k = t.keys[next16(code, &pc)];
                const g = builtins.global();
                if (!c.jsrt_has_prop(g, k)) {
                    if (o == .typeof_global) push(vs, &top, rt.string("undefined")) else throwFmt(&c.jsrt_class_reference_error, "{s} is not defined", .{keyText(k)});
                } else {
                    const v = c.jsrt_get_prop(g, k, null);
                    push(vs, &top, if (o == .typeof_global) c.jsrt_typeof(v) else v);
                }
            },
            .store_global => {
                const g = builtins.global();
                const k = t.keys[next16(code, &pc)];
                const strict = next8(code, &pc) != 0;
                top -= 1;
                if (strict and !c.jsrt_has_prop(g, k)) throwFmt(&c.jsrt_class_reference_error, "{s} is not defined", .{keyText(k)}) else c.jsrt_set_prop(g, k, vs[top], null);
            },
            .delete_global => {
                const k = t.keys[next16(code, &pc)];
                push(vs, &top, rt.boolean(c.jsrt_delete(builtins.global(), rt.string(keyText(k)))));
            },
            .declare_global => {
                const k = t.keys[next16(code, &pc)];
                const g = builtins.global();
                if (!c.jsrt_has_prop(g, k)) c.jsrt_set_prop(g, k, rt.undefined_value, null);
            },
            .push_env => {
                frame.env = c.jsrt_env_new(frame.env, next16(code, &pc));
            },
            .pop_env => frame.env = frame.env.*.parent,
            .clone_env => frame.env = c.jsrt_env_clone(frame.env),
            .save_env => {
                locals[next16(code, &pc)] = boxPtr(frame.env);
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
            .rest => {
                const i = next16(code, &pc);
                const from = @min(i, argv.len);
                push(vs, &top, c.jsrt_array_new(@intCast(argv.len - from), argv[from..].ptr));
            },
            .arguments => push(vs, &top, c.jsrt_array_new(@intCast(argv.len), argv.ptr)),
            .this_raw => push(vs, &top, w[1]),
            .this_sloppy => push(vs, &top, if (c.jsrt_is_nullish(w[1])) builtins.global() else w[1]),
            .new_target => push(vs, &top, w[2]),
            .callee => push(vs, &top, w[0]),
            .home => push(vs, &top, if (fe) |e| e.slots()[compile.fnenv_home] else rt.undefined_value),

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

            inline .add, .bitand, .bitor, .bitxor, .shl, .shr, .ushr => |op| binop(vs, &top, @field(c, "jsrt_op_" ++ @tagName(op))),
            .sub, .mul, .div, .mod => {
                top -= 1;
                const a = c.jsrt_to_number(vs[top - 1]);
                const b = if (rt.pending()) 0 else c.jsrt_to_number(vs[top]);
                vs[top - 1] = rt.number(switch (o) {
                    .sub => a - b,
                    .mul => a * b,
                    .div => a / b,
                    else => jsMod(a, b),
                });
            },
            .exp => binop(vs, &top, c.jsrt_math_pow),
            .neg => vs[top - 1] = rt.number(-c.jsrt_to_number(vs[top - 1])),
            .plus => vs[top - 1] = rt.number(c.jsrt_to_number(vs[top - 1])),
            .bitnot => vs[top - 1] = c.jsrt_op_bitnot(vs[top - 1]),
            .not => vs[top - 1] = rt.boolean(!c.jsrt_truthy(vs[top - 1])),
            .typeof => vs[top - 1] = c.jsrt_typeof(vs[top - 1]),
            .inc => vs[top - 1] = rt.number(c.jsrt_to_number(vs[top - 1]) + 1),
            .dec => vs[top - 1] = rt.number(c.jsrt_to_number(vs[top - 1]) - 1),
            .eq, .ne, .seq, .sne, .lt, .gt, .le, .ge => {
                top -= 1;
                const a = vs[top - 1];
                const b = vs[top];
                vs[top - 1] = rt.boolean(switch (o) {
                    .eq => c.jsrt_loose_equals(a, b),
                    .ne => !c.jsrt_loose_equals(a, b),
                    .seq => c.jsrt_strict_equals(a, b),
                    .sne => !c.jsrt_strict_equals(a, b),
                    .lt => c.jsrt_op_lt(a, b),
                    .gt => c.jsrt_op_gt(a, b),
                    .le => c.jsrt_op_le(a, b),
                    else => c.jsrt_op_ge(a, b),
                });
            },
            .to_string => vs[top - 1] = c.jsrt_to_string(vs[top - 1]),
            .to_key => vs[top - 1] = toKey(vs[top - 1]),

            .jump => pc = bc.read32(code, pc),
            .jump_if_false, .jump_if_true, .jump_if_nullish, .jump_if_not_undef => {
                top -= 1;
                const v = vs[top];
                const taken = switch (o) {
                    .jump_if_false => !c.jsrt_truthy(v),
                    .jump_if_true => c.jsrt_truthy(v),
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
                const v = vs[top];
                const this = vs[top + 1];
                if (w[2] == rt.undefined_value or rt.isObjectLike(v)) return v;
                if (t.kind == .derived_ctor and v != rt.undefined_value) {
                    rt.throwType("Derived constructors may only return object or undefined");
                } else if (this == rt.uninitialized) {
                    rt.throwReference("Must call super constructor in derived class before accessing 'this' or returning from derived constructor");
                } else return this;
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
                const arr = c.jsrt_array_new(n, vs[top - n ..].ptr);
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

            .get_iterator => vs[top - 1] = getIterator(vs[top - 1]),
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
        }
        if (rt.pending()) {
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

fn binop(vs: []Value, top: *usize, comptime f: anytype) void {
    top.* -= 1;
    vs[top.* - 1] = f(vs[top.* - 1], vs[top.*]);
}

fn instanceOfValue(v: Value, target: Value) Value {
    return rt.boolean(instanceOf(v, target));
}

fn jsMod(a: f64, b: f64) f64 {
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

fn tdzError(name: [*:0]const u8) void {
    const n = keyText(name);
    if (std.mem.eql(u8, n, "%this")) {
        rt.throwReference("Must call super constructor in derived class before accessing 'this' or returning from derived constructor");
    } else throwFmt(&c.jsrt_class_reference_error, "Cannot access '{s}' before initialization", .{n});
}

fn findHandler(t: *Template, pc: usize) ?bc.Handler {
    for (t.handlers) |h| if (pc >= h.start and pc < h.end) return h;
    return null;
}
