//! The global object an interpreted script runs against (docs/INTERPRETER.md §5). Where the
//! runtime already has a builtin — Map, Date, JSON, the Math functions — the global names it;
//! the rest are Zig natives over the runtime's helpers, written for what an interpreted program
//! reaches by name: the error constructors, `Object`'s reflection, `Symbol`. Symbols are strings
//! spelled `__@name`, the key the runtime itself resolves `Symbol.iterator` by.

const std = @import("std");
const rt = @import("rt.zig");
const c = rt.c;
const vm = @import("vm.zig");
const Value = rt.Value;
const Env = c.JSRTEnv;

const Native = *const fn (u32, [*c]const Value, [*c]Env) callconv(.c) Value;

// ---------------------------------------------------------------------- roots

/// Everything here is reachable from this frame, which sits under every other frame on the
/// thread and is never popped.
const root_slots = 32;
threadlocal var roots: [root_slots]Value = @splat(rt.undefined_value);
threadlocal var root_frame: c.JSRTFrame = undefined;
threadlocal var ready = false;

const slot_global = 0;
const slot_object_proto = 1;
const slot_errors = 2; // one per ErrorKind
const slot_symbol_count = slot_errors + error_kinds.len;
const slot_function_proto = slot_symbol_count + 1;

const ErrorKind = struct { name: [*:0]const u8, class: *const c.JSRTClass };
const error_kinds = [_]ErrorKind{
    .{ .name = "Error", .class = &c.jsrt_class_error },
    .{ .name = "TypeError", .class = &c.jsrt_class_type_error },
    .{ .name = "RangeError", .class = &c.jsrt_class_range_error },
    .{ .name = "ReferenceError", .class = &c.jsrt_class_reference_error },
    .{ .name = "SyntaxError", .class = &c.jsrt_class_syntax_error },
    // The runtime has no classes of these two; their instances are plain errors.
    .{ .name = "EvalError", .class = &c.jsrt_class_error },
    .{ .name = "URIError", .class = &c.jsrt_class_error },
};

/// The runtime's builtin constructors the global names, which `new` reaches through
/// `jsrt_construct`.
const runtime_ctors = [_][*:0]const u8{ "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "ArrayBuffer", "DataView", "Uint8Array", "Promise" };

pub fn global() Value {
    init();
    return roots[slot_global];
}

pub fn objectPrototype() Value {
    init();
    return roots[slot_object_proto];
}

/// Makes the global object. Needs `jsrt_init` to have run on this thread.
pub fn init() void {
    if (ready) return;
    ready = true;
    root_frame = .{ .prev = c.jsrt_frame_top, .count = root_slots, .slots = &roots, .env = null };
    c.jsrt_frame_top = &root_frame;
    roots[slot_symbol_count] = rt.number(0);
    const g = c.jsrt_dynobj_new();
    roots[slot_global] = g;
    roots[slot_object_proto] = c.jsrt_builtin_proto("Object");
    populate(g);
}

fn native(name: [*:0]const u8, arity: u32, f: Native) Value {
    return c.jsrt_closure_new(f, arity, name, null, true);
}

fn put(obj: Value, key: [*:0]const u8, v: Value) void {
    vm.defineOwn(obj, key, v);
}

fn method(obj: Value, key: [*:0]const u8, arity: u32, f: Native) void {
    put(obj, key, native(key, arity, f));
}

/// A global constructor tied to the runtime's prototype of the same name, both ways.
fn wrapper(g: Value, name: [*:0]const u8, f: Value) Value {
    const proto = c.jsrt_builtin_proto(name);
    put(g, name, f);
    put(f, "prototype", proto);
    put(proto, "constructor", f);
    return f;
}

const wrapped = .{ "Object", "Array", "String", "Number", "Boolean", "Function" };

/// The global a runtime builtin constructor stands for: `[].constructor` is the runtime's
/// Array, and a script compares it with the global one.
pub fn globalConstructor(v: Value) Value {
    if (!rt.is(v, c.JSRT_TAG_CLOSURE)) return v;
    inline for (wrapped) |name| if (c.jsrt_builtin_ctor(name) == v) return c.jsrt_get_prop(global(), name, null);
    return v;
}

pub fn functionPrototype() Value {
    init();
    return roots[slot_function_proto];
}

fn arg(argc: u32, argv: [*c]const Value, i: u32) Value {
    return if (i + 1 < argc) argv[i + 1] else rt.undefined_value;
}

fn args(argc: u32, argv: [*c]const Value) []const Value {
    return if (argc > 1) argv[1..argc] else &.{};
}

fn populate(g: Value) void {
    put(g, "globalThis", g);
    put(g, "undefined", rt.undefined_value);
    put(g, "NaN", rt.number(std.math.nan(f64)));
    put(g, "Infinity", rt.number(std.math.inf(f64)));

    for (error_kinds, 0..) |k, i| {
        const env = c.jsrt_env_new(null, 1);
        env.*.slots()[0] = rt.number(@floatFromInt(i));
        const f = c.jsrt_closure_new(&errorNative, 1, k.name, env, true);
        roots[slot_errors + i] = f;
        put(g, k.name, f);
    }
    for (runtime_ctors) |name| {
        const ctor = c.jsrt_builtin_ctor(name);
        put(g, name, ctor);
        put(ctor, "prototype", c.jsrt_builtin_proto(name));
    }

    const fproto = c.jsrt_builtin_proto("Function");
    roots[slot_function_proto] = fproto;
    method(fproto, "call", 1, &fnCall);
    method(fproto, "apply", 2, &fnApply);
    method(fproto, "bind", 1, &fnBind);
    method(fproto, "toString", 0, &fnToString);
    _ = wrapper(g, "Function", native("Function", 1, &functionCall));

    const object = wrapper(g, "Object", native("Object", 1, &objectCall));
    method(object, "create", 2, &objectCreate);
    method(object, "getPrototypeOf", 1, &objectGetPrototypeOf);
    method(object, "setPrototypeOf", 2, &objectSetPrototypeOf);
    method(object, "defineProperty", 3, &objectDefineProperty);
    method(object, "getOwnPropertyDescriptor", 2, &objectGetOwnPropertyDescriptor);
    method(object, "keys", 1, &objectKeys);
    method(object, "values", 1, &objectValues);
    method(object, "entries", 1, &objectEntries);
    method(object, "getOwnPropertyNames", 1, &objectGetOwnPropertyNames);
    method(object, "getOwnPropertySymbols", 1, &objectGetOwnPropertySymbols);
    method(object, "assign", 2, &objectAssign);
    method(object, "freeze", 1, &objectFreeze);
    method(object, "isFrozen", 1, &objectIsFrozen);
    method(object, "hasOwn", 2, &objectHasOwn);
    method(object, "is", 2, &objectIs);
    const proto = roots[slot_object_proto];
    method(proto, "hasOwnProperty", 1, &protoHasOwnProperty);
    put(proto, "toString", c.jsrt_object_proto_method("toString"));
    method(proto, "propertyIsEnumerable", 1, &protoPropertyIsEnumerable);
    method(proto, "valueOf", 0, &protoValueOf);

    const array = wrapper(g, "Array", native("Array", 1, &arrayCall));
    method(array, "isArray", 1, &arrayIsArray);
    method(array, "of", 0, &arrayOf);
    method(array, "from", 1, &arrayFrom);
    forwarders(c.jsrt_builtin_proto("Array"), .array, &array_methods);

    _ = wrapper(g, "String", native("String", 1, &stringCall));
    forwarders(c.jsrt_builtin_proto("String"), .string, &string_methods);
    const number = wrapper(g, "Number", native("Number", 1, &numberCall));
    put(number, "MAX_SAFE_INTEGER", rt.number(9007199254740991));
    put(number, "MIN_SAFE_INTEGER", rt.number(-9007199254740991));
    put(number, "MAX_VALUE", rt.number(std.math.floatMax(f64)));
    put(number, "MIN_VALUE", rt.number(5e-324));
    put(number, "EPSILON", rt.number(std.math.floatEps(f64)));
    put(number, "NaN", rt.number(std.math.nan(f64)));
    put(number, "POSITIVE_INFINITY", rt.number(std.math.inf(f64)));
    put(number, "NEGATIVE_INFINITY", rt.number(-std.math.inf(f64)));
    method(number, "isNaN", 1, &numberIsNaN);
    method(number, "isInteger", 1, &numberIsInteger);
    _ = wrapper(g, "Boolean", native("Boolean", 1, &booleanCall));
    method(g, "eval", 1, &evalNative);

    const symbol = native("Symbol", 0, &symbolCall);
    put(g, "Symbol", symbol);
    inline for (.{ "iterator", "asyncIterator", "hasInstance", "toPrimitive", "toStringTag", "species", "unscopables", "isConcatSpreadable", "match", "matchAll", "replace", "search", "split" }) |name| {
        put(symbol, name, rt.string("__@" ++ name));
    }
    method(symbol, "for", 1, &symbolFor);

    const math = c.jsrt_dynobj_new();
    put(g, "Math", math);
    inline for (.{ "abs", "clz32", "fround", "ceil", "floor", "round", "sign", "sqrt", "trunc", "acos", "acosh", "asin", "asinh", "atan", "atanh", "cbrt", "cos", "cosh", "exp", "expm1", "log", "log10", "log1p", "log2", "sin", "sinh", "tan", "tanh" }) |name| {
        method(math, name, 1, unaryMath(@field(c, "jsrt_math_" ++ name)));
    }
    inline for (.{ "imul", "pow", "atan2" }) |name| {
        method(math, name, 2, binaryMath(@field(c, "jsrt_math_" ++ name)));
    }
    method(math, "max", 2, &mathMax);
    method(math, "min", 2, &mathMin);
    method(math, "random", 0, &mathRandom);
    put(math, "PI", rt.number(std.math.pi));
    put(math, "E", rt.number(std.math.e));
    put(math, "LN2", rt.number(std.math.ln2));
    put(math, "LN10", rt.number(std.math.ln10));
    put(math, "LOG2E", rt.number(std.math.log2e));
    put(math, "LOG10E", rt.number(std.math.log10e));
    put(math, "SQRT2", rt.number(std.math.sqrt2));
    put(math, "SQRT1_2", rt.number(std.math.sqrt1_2));

    const json = c.jsrt_dynobj_new();
    put(g, "JSON", json);
    method(json, "stringify", 1, unaryMath(c.jsrt_json_stringify));
    method(json, "parse", 1, unaryMath(c.jsrt_json_parse));

    method(g, "isNaN", 1, unaryMath(c.jsrt_global_is_nan));
    method(g, "isFinite", 1, unaryMath(c.jsrt_global_is_finite));
    method(g, "parseInt", 2, binaryMath(c.jsrt_global_parse_int));
    method(g, "parseFloat", 1, unaryMath(c.jsrt_global_parse_float));
    method(g, "print", 1, &printNative);

    const host = c.jsrt_dynobj_new();
    put(g, "$262", host);
    put(host, "global", g);
    method(host, "evalScript", 1, &evalScriptNative);
    method(host, "gc", 0, &noop);
}

// ---------------------------------------------------------------------- errors

fn errorKindOf(f: Value) ?usize {
    for (0..error_kinds.len) |i| if (roots[slot_errors + i] == f) return i;
    return null;
}

fn errorNative(argc: u32, argv: [*c]const Value, env: [*c]Env) callconv(.c) Value {
    const i: usize = @intFromFloat(c.jsrt_to_number(env.*.slots()[0]));
    const msg = arg(argc, argv, 0);
    const text = if (msg == rt.undefined_value) rt.string("") else c.jsrt_to_string(msg);
    if (rt.pending()) return rt.undefined_value;
    return c.jsrt_error_new(error_kinds[i].class, text);
}

/// `e.constructor` for an error object, which the runtime has no answer for.
pub fn errorConstructorOf(e: Value) Value {
    init();
    const cls = @as(*const c.JSRTObject, @ptrCast(@alignCast(c.jsrt_ptr(e)))).cls;
    for (error_kinds, 0..) |k, i| if (k.class == cls) return roots[slot_errors + i];
    return roots[slot_errors];
}

pub fn isConstructor(f: Value) bool {
    if (errorKindOf(f) != null) return true;
    if (boundOf(f)) |env| return vm.isConstructor(env.slots()[bound_target]);
    for (runtime_ctors) |name| if (c.jsrt_builtin_ctor(name) == f) return true;
    const g = global();
    inline for (wrapped) |name| if (c.jsrt_get_prop(g, name, null) == f) return true;
    return false;
}

pub fn construct(f: Value, argv: []const Value, nt: Value) Value {
    if (errorKindOf(f) != null) return vm.call(f, rt.undefined_value, argv);
    if (boundOf(f)) |env| {
        // §10.4.1.2: a bound function's new.target is its target when it was itself.
        const target = env.slots()[bound_target];
        var frame: Frame(1) = .{};
        frame.open(.{boundArgs(env, argv)});
        defer frame.pop();
        return vm.construct(target, vm.arrayItems(frame.slots[0]), if (nt == f) target else nt);
    }
    for (runtime_ctors) |name| if (c.jsrt_builtin_ctor(name) == f) return c.jsrt_construct(f, @intCast(argv.len), argv.ptr);
    // Object, Array and the primitive wrappers answer a construction as a call (the wrappers
    // without the wrapper object, which the runtime does not model).
    return vm.call(f, rt.undefined_value, argv);
}

/// `v instanceof f` for the constructors this module defines, or null for the rest.
pub fn instanceOf(v: Value, f: Value) ?bool {
    if (errorKindOf(f)) |i| {
        if (!c.jsrt_is_error(v)) return false;
        if (i == 0) return true;
        const cls = @as(*const c.JSRTObject, @ptrCast(@alignCast(c.jsrt_ptr(v)))).cls;
        return cls == error_kinds[i].class;
    }
    const g = global();
    if (c.jsrt_get_prop(g, "Object", null) == f) return rt.isObjectLike(v);
    if (c.jsrt_get_prop(g, "Array", null) == f) return rt.is(v, c.JSRT_TAG_ARRAY);
    return null;
}

// ---------------------------------------------------------------------- Function

fn functionCall(_: u32, _: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    c.jsrt_throw_error(&c.jsrt_class_error, "new Function is not supported by the interpreter yet (T14.3)");
    return rt.undefined_value;
}

fn requireCallable(f: Value, what: [*:0]const u8) bool {
    if (rt.is(f, c.JSRT_TAG_CLOSURE)) return true;
    rt.throwType(what);
    return false;
}

fn fnCall(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    if (!requireCallable(argv[0], "Function.prototype.call called on a non-function")) return rt.undefined_value;
    const rest = args(argc, argv);
    return vm.call(argv[0], arg(argc, argv, 0), if (rest.len > 0) rest[1..] else rest);
}

/// CreateListFromArrayLike (§7.3.18), as an array the caller roots.
fn listFromArrayLike(v: Value) Value {
    if (rt.is(v, c.JSRT_TAG_ARRAY)) return v;
    if (!rt.isObjectLike(v)) {
        rt.throwType("CreateListFromArrayLike called on non-object");
        return rt.undefined_value;
    }
    var frame: Frame(1) = .{};
    frame.open(.{c.jsrt_array_new(0, null)});
    defer frame.pop();
    const n = c.jsrt_to_number(vm.getProp(v, "length", null));
    if (rt.pending()) return rt.undefined_value;
    var i: f64 = 0;
    while (i < n) : (i += 1) {
        const item = c.jsrt_dyn_index_get(v, rt.number(i), null);
        if (rt.pending()) return rt.undefined_value;
        _ = c.jsrt_array_push(frame.slots[0], item);
    }
    return frame.slots[0];
}

fn fnApply(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    if (!requireCallable(argv[0], "Function.prototype.apply called on a non-function")) return rt.undefined_value;
    const list = arg(argc, argv, 1);
    if (c.jsrt_is_nullish(list)) return vm.call(argv[0], arg(argc, argv, 0), &.{});
    var frame: Frame(1) = .{};
    frame.open(.{listFromArrayLike(list)});
    defer frame.pop();
    if (rt.pending()) return rt.undefined_value;
    return vm.call(argv[0], arg(argc, argv, 0), vm.arrayItems(frame.slots[0]));
}

const bound_target = 0;
const bound_this = 1;
const bound_args = 2;

fn boundOf(f: Value) ?*Env {
    if (!rt.is(f, c.JSRT_TAG_CLOSURE)) return null;
    const clo: *c.JSRTClosure = @ptrCast(@alignCast(c.jsrt_ptr(f)));
    if (clo.@"fn" != &boundCall) return null;
    return clo.env;
}

/// The bound arguments, then the call's own.
fn boundArgs(env: *Env, argv: []const Value) Value {
    const all = c.jsrt_array_new(0, null);
    for (vm.arrayItems(env.slots()[bound_args])) |v| _ = c.jsrt_array_push(all, v);
    for (argv) |v| _ = c.jsrt_array_push(all, v);
    return all;
}

fn boundCall(argc: u32, argv: [*c]const Value, env: [*c]Env) callconv(.c) Value {
    var frame: Frame(1) = .{};
    frame.open(.{boundArgs(env, args(argc, argv))});
    defer frame.pop();
    return vm.call(env.*.slots()[bound_target], env.*.slots()[bound_this], vm.arrayItems(frame.slots[0]));
}

fn fnBind(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const target = argv[0];
    if (!requireCallable(target, "Bind must be called on a function")) return rt.undefined_value;
    const env = c.jsrt_env_new(null, 3);
    env.*.slots()[bound_target] = target;
    env.*.slots()[bound_this] = arg(argc, argv, 0);
    const rest = args(argc, argv);
    const extra = if (rest.len > 0) rest[1..] else rest;
    env.*.slots()[bound_args] = c.jsrt_array_new(@intCast(extra.len), extra.ptr);
    var name_buf: [256]u8 = undefined;
    var target_name: [128]u8 = undefined;
    const tn = keyText(vm.getProp(target, "name", null), &target_name);
    const name = std.fmt.bufPrintSentinel(&name_buf, "bound {s}", .{tn}, 0) catch "bound";
    const len = c.jsrt_to_number(vm.getProp(target, "length", null));
    const arity: u32 = if (std.math.isNan(len) or len <= @as(f64, @floatFromInt(extra.len))) 0 else @intFromFloat(@min(len - @as(f64, @floatFromInt(extra.len)), 1 << 30));
    return c.jsrt_closure_new(&boundCall, arity, c.jsrt_shape_key(rt.string(name)), env, true);
}

/// A string value's bytes, copied into `buf`; "" for anything else.
fn keyText(v: Value, buf: []u8) []const u8 {
    if (!rt.is(v, c.JSRT_TAG_STRING)) return "";
    const p = c.jsrt_shape_key_ephemeral(v);
    defer std.c.free(p);
    const s = std.mem.span(p);
    const n = @min(s.len, buf.len);
    @memcpy(buf[0..n], s[0..n]);
    return buf[0..n];
}

fn fnToString(_: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    if (!requireCallable(argv[0], "Function.prototype.toString requires that 'this' be a Function")) return rt.undefined_value;
    var name_buf: [128]u8 = undefined;
    var buf: [256]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, "function {s}() {{ [native code] }}", .{keyText(vm.getProp(argv[0], "name", null), &name_buf)}) catch "function () { [native code] }";
    return rt.string(s);
}

/// `eval(x)` as an indirect eval (§19.2.1): the global scope, sloppy unless the source says
/// otherwise. A direct eval's access to the caller's scope is T14.3's.
fn evalNative(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const x = arg(argc, argv, 0);
    if (!rt.is(x, c.JSRT_TAG_STRING)) return x;
    const p = c.jsrt_shape_key_ephemeral(x);
    defer std.c.free(p);
    return @import("interp.zig").evalScript(std.mem.span(p), false);
}

// ---------------------------------------------------------------------- Object

fn objectCall(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const v = arg(argc, argv, 0);
    return if (rt.isObjectLike(v)) v else c.jsrt_dynobj_new();
}

fn requireObject(v: Value, what: []const u8) bool {
    if (rt.isObjectLike(v)) return true;
    var buf: [128]u8 = undefined;
    const msg = std.fmt.bufPrintSentinel(&buf, "{s} called on non-object", .{what}, 0) catch "called on non-object";
    rt.throwType(msg.ptr);
    return false;
}

fn objectCreate(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const p = arg(argc, argv, 0);
    if (p == rt.null_value) return c.jsrt_null_proto_new();
    if (!rt.isObjectLike(p)) {
        rt.throwType("Object prototype may only be an Object or null");
        return rt.undefined_value;
    }
    const o = c.jsrt_dynobj_new();
    vm.setProto(o, p);
    const props = arg(argc, argv, 1);
    if (rt.isObjectLike(props)) defineProperties(o, props);
    return o;
}

fn defineProperties(o: Value, props: Value) void {
    const keys = c.jsrt_object_keys(props);
    var frame: Frame(1) = .{};
    frame.open(.{keys});
    defer frame.pop();
    for (vm.arrayItems(keys)) |k| {
        defineFromDescriptor(o, c.jsrt_shape_key(k), c.jsrt_get_prop_value(props, k, null));
        if (rt.pending()) return;
    }
}

/// A shadow-stack frame for values a native holds across allocations: a boxed value in a Zig
/// local is not a root.
pub fn Frame(comptime n: usize) type {
    return struct {
        slots: [n]Value = @splat(rt.undefined_value),
        frame: c.JSRTFrame = undefined,

        pub fn open(self: *@This(), values: [n]Value) void {
            self.slots = values;
            self.frame = .{ .prev = c.jsrt_frame_top, .count = n, .slots = &self.slots, .env = null };
            c.jsrt_frame_top = &self.frame;
        }

        pub fn pop(self: *@This()) void {
            c.jsrt_frame_top = self.frame.prev;
        }
    };
}

fn defineFromDescriptor(o: Value, key: [*:0]const u8, desc: Value) void {
    if (!rt.isObjectLike(desc)) {
        rt.throwType("Property description must be an object");
        return;
    }
    const get = if (c.jsrt_has_prop(desc, "get")) c.jsrt_get_prop(desc, "get", null) else rt.undefined_value;
    const set = if (c.jsrt_has_prop(desc, "set")) c.jsrt_get_prop(desc, "set", null) else rt.undefined_value;
    if (get != rt.undefined_value or set != rt.undefined_value) {
        if (get != rt.undefined_value) vm.defineAccessor(o, key, get, false);
        if (set != rt.undefined_value) vm.defineAccessor(o, key, set, true);
        return;
    }
    vm.defineOwn(o, key, c.jsrt_get_prop(desc, "value", null));
}

fn objectGetPrototypeOf(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const o = arg(argc, argv, 0);
    if (c.jsrt_is_nullish(o)) {
        rt.throwType("Cannot convert undefined or null to object");
        return rt.undefined_value;
    }
    return vm.prototypeOf(o);
}

fn objectSetPrototypeOf(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const o = arg(argc, argv, 0);
    vm.setProto(o, arg(argc, argv, 1));
    return o;
}

fn objectDefineProperty(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const o = arg(argc, argv, 0);
    if (!requireObject(o, "Object.defineProperty")) return rt.undefined_value;
    const k = c.jsrt_shape_key(c.jsrt_to_string(arg(argc, argv, 1)));
    defineFromDescriptor(o, k, arg(argc, argv, 2));
    return o;
}

fn objectGetOwnPropertyDescriptor(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const o = arg(argc, argv, 0);
    const kv = c.jsrt_to_string(arg(argc, argv, 1));
    if (!rt.isObjectLike(o)) return rt.undefined_value;
    if (!c.jsrt_truthy(hasOwn(o, kv))) return rt.undefined_value;
    const k = c.jsrt_shape_key(kv);
    var frame: Frame(2) = .{};
    frame.open(.{ c.jsrt_dynobj_new(), rt.undefined_value });
    defer frame.pop();
    const desc = frame.slots[0];
    if (vm.ownAccessor(o, k)) |pair| {
        put(desc, "get", pair[0]);
        put(desc, "set", pair[1]);
    } else {
        put(desc, "value", c.jsrt_get_prop(o, k, null));
        put(desc, "writable", rt.true_value);
    }
    put(desc, "enumerable", rt.true_value);
    put(desc, "configurable", rt.true_value);
    return desc;
}

fn objectKeys(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return keysWhere(c.jsrt_object_keys(reflectTarget(arg(argc, argv, 0))), false);
}

fn objectValues(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return c.jsrt_object_values(reflectTarget(arg(argc, argv, 0)));
}

fn objectEntries(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return c.jsrt_object_entries(reflectTarget(arg(argc, argv, 0)));
}

fn objectGetOwnPropertyNames(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return keysWhere(c.jsrt_object_get_own_property_names(reflectTarget(arg(argc, argv, 0))), false);
}

/// What the runtime's key walks can read for `v`: they take objects, arrays and strings (and
/// throw on nullish); a function's own properties live in a table of their own, and any other
/// primitive's ToObject has no enumerable own keys.
fn reflectTarget(v: Value) Value {
    if (rt.is(v, c.JSRT_TAG_OBJECT) or rt.is(v, c.JSRT_TAG_ARRAY) or rt.is(v, c.JSRT_TAG_STRING) or c.jsrt_is_nullish(v)) return v;
    if (rt.is(v, c.JSRT_TAG_CLOSURE)) {
        if (vm.closureProps(v)) |props| return props;
    }
    return c.jsrt_dynobj_new();
}

fn objectAssign(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const target = arg(argc, argv, 0);
    for (args(argc, argv)[@min(1, argc -| 1)..]) |src| {
        if (!c.jsrt_is_nullish(src)) _ = c.jsrt_object_assign(target, src);
    }
    return target;
}

fn objectFreeze(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return c.jsrt_object_freeze(arg(argc, argv, 0));
}

fn objectIsFrozen(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return c.jsrt_object_is_frozen(arg(argc, argv, 0));
}

fn objectHasOwn(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return hasOwn(arg(argc, argv, 0), arg(argc, argv, 1));
}

/// HasOwnProperty(ToObject(v), ToPropertyKey(key)) (§7.3.12) over every kind of value; the
/// runtime's `jsrt_object_has_own` takes only fixed and dynamic objects.
pub fn hasOwn(v: Value, key: Value) Value {
    if (c.jsrt_is_nullish(v)) {
        rt.throwType("Cannot convert undefined or null to object");
        return rt.undefined_value;
    }
    var frame: Frame(2) = .{};
    frame.open(.{ v, c.jsrt_to_string(key) });
    defer frame.pop();
    if (rt.pending()) return rt.undefined_value;
    const k = frame.slots[1];
    var buf: [64]u8 = undefined;
    const name = keyText(k, &buf);
    if (rt.is(v, c.JSRT_TAG_OBJECT)) return c.jsrt_object_has_own(v, k);
    if (rt.is(v, c.JSRT_TAG_STRING) or rt.is(v, c.JSRT_TAG_ARRAY)) {
        if (std.mem.eql(u8, name, "length")) return rt.true_value;
        const len = c.jsrt_to_number(c.jsrt_get_prop(v, "length", null));
        const i = std.fmt.parseInt(u32, name, 10) catch return rt.false_value;
        // "01" is not an index.
        if (name.len > 1 and name[0] == '0') return rt.false_value;
        if (@as(f64, @floatFromInt(i)) >= len) return rt.false_value;
        return rt.boolean(!rt.is(v, c.JSRT_TAG_ARRAY) or vm.arrayItems(v)[i] != c.JSRT_HOLE);
    }
    if (rt.is(v, c.JSRT_TAG_CLOSURE)) {
        if (vm.closureHasOwn(v, c.jsrt_shape_key(k))) return rt.true_value;
        if (std.mem.eql(u8, name, "length") or std.mem.eql(u8, name, "name")) return rt.true_value;
        return rt.boolean(std.mem.eql(u8, name, "prototype") and vm.isConstructor(v));
    }
    return rt.false_value;
}

fn objectIs(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return rt.boolean(c.jsrt_same_value(arg(argc, argv, 0), arg(argc, argv, 1)));
}

fn protoPropertyIsEnumerable(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const this = argv[0];
    if (!rt.isObjectLike(this)) return rt.false_value;
    return hasOwn(this, arg(argc, argv, 0));
}

fn protoHasOwnProperty(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return hasOwn(argv[0], arg(argc, argv, 0));
}

fn protoValueOf(_: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return argv[0];
}

// ---------------------------------------------------------------------- Array

fn arrayCall(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const a = args(argc, argv);
    if (a.len == 1 and c.jsrt_is_number(a[0])) {
        const n = c.jsrt_to_number(a[0]);
        if (n < 0 or n != @trunc(n) or n > 4294967295) {
            rt.throwRange("Invalid array length");
            return rt.undefined_value;
        }
        const arr = c.jsrt_array_new(0, null);
        var i: f64 = 0;
        while (i < n) : (i += 1) _ = c.jsrt_array_push(arr, c.JSRT_HOLE);
        return arr;
    }
    return c.jsrt_array_new(@intCast(a.len), a.ptr);
}

fn arrayIsArray(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return rt.boolean(rt.is(arg(argc, argv, 0), c.JSRT_TAG_ARRAY));
}

fn arrayOf(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const a = args(argc, argv);
    return c.jsrt_array_new(@intCast(a.len), a.ptr);
}

fn arrayFrom(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    var frame: Frame(2) = .{};
    frame.open(.{ c.jsrt_array_new(0, null), vm.getIterator(arg(argc, argv, 0)) });
    defer frame.pop();
    if (rt.pending()) return rt.undefined_value;
    var v: Value = undefined;
    while (vm.iterStep(frame.slots[1], &v)) _ = c.jsrt_array_push(frame.slots[0], v);
    return frame.slots[0];
}

// ---------------------------------------------------------------------- primitives

fn stringCall(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    if (argc < 2) return rt.string("");
    const v = argv[1];
    // `String(sym)` is the one conversion of a symbol that does not throw.
    if (rt.is(v, c.JSRT_TAG_STRING)) {
        const p = c.jsrt_shape_key_ephemeral(v);
        defer std.c.free(p);
        const s = std.mem.span(p);
        if (std.mem.startsWith(u8, s, "__@")) {
            var buf: [256]u8 = undefined;
            const shown = std.fmt.bufPrint(&buf, "Symbol({s})", .{symbolDescription(s)}) catch s;
            return rt.string(shown);
        }
        return v;
    }
    return c.jsrt_to_string(v);
}

fn symbolDescription(s: []const u8) []const u8 {
    const rest = s[3..];
    if (std.mem.startsWith(u8, rest, "sym:")) {
        const colon = std.mem.indexOfScalarPos(u8, rest, 4, ':') orelse return "";
        return rest[colon + 1 ..];
    }
    if (std.mem.startsWith(u8, rest, "for:")) return rest[4..];
    return rest;
}

fn numberCall(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return if (argc < 2) rt.number(0) else rt.number(c.jsrt_to_number(argv[1]));
}

fn booleanCall(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return rt.boolean(argc >= 2 and c.jsrt_truthy(argv[1]));
}

fn numberIsNaN(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const v = arg(argc, argv, 0);
    return rt.boolean(c.jsrt_is_number(v) and std.math.isNan(c.jsrt_to_number(v)));
}

fn numberIsInteger(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const v = arg(argc, argv, 0);
    if (!c.jsrt_is_number(v)) return rt.false_value;
    const d = c.jsrt_to_number(v);
    return rt.boolean(std.math.isFinite(d) and d == @trunc(d));
}

fn symbolCall(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const n = c.jsrt_to_number(roots[slot_symbol_count]) + 1;
    roots[slot_symbol_count] = rt.number(n);
    const d = arg(argc, argv, 0);
    var desc: []const u8 = "";
    var owned: ?[*:0]u8 = null;
    defer if (owned) |p| std.c.free(p);
    if (d != rt.undefined_value) {
        owned = c.jsrt_shape_key_ephemeral(c.jsrt_to_string(d));
        desc = std.mem.span(owned.?);
    }
    var buf: [512]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, "__@sym:{d}:{s}", .{ @as(u64, @intFromFloat(n)), desc }) catch "__@sym";
    return rt.string(s);
}

fn symbolFor(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return c.jsrt_op_add(rt.string("__@for:"), c.jsrt_to_string(arg(argc, argv, 0)));
}

fn unaryMath(comptime f: anytype) Native {
    return &struct {
        fn call(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
            return f(arg(argc, argv, 0));
        }
    }.call;
}

fn binaryMath(comptime f: anytype) Native {
    return &struct {
        fn call(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
            return f(arg(argc, argv, 0), arg(argc, argv, 1));
        }
    }.call;
}

fn mathMax(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    var r = rt.number(-std.math.inf(f64));
    for (args(argc, argv)) |v| r = c.jsrt_math_max(r, v);
    return r;
}

fn mathMin(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    var r = rt.number(std.math.inf(f64));
    for (args(argc, argv)) |v| r = c.jsrt_math_min(r, v);
    return r;
}

fn mathRandom(_: u32, _: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return c.jsrt_math_random();
}

// ---------------------------------------------------------------------- host

fn printNative(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const s = c.jsrt_to_string(arg(argc, argv, 0));
    if (rt.pending()) return rt.undefined_value;
    const p = c.jsrt_shape_key_ephemeral(s);
    defer std.c.free(p);
    const text = std.mem.span(p);
    _ = std.c.write(1, text.ptr, text.len);
    _ = std.c.write(1, "\n", 1);
    return rt.undefined_value;
}

fn evalScriptNative(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    const s = c.jsrt_to_string(arg(argc, argv, 0));
    if (rt.pending()) return rt.undefined_value;
    const p = c.jsrt_shape_key_ephemeral(s);
    defer std.c.free(p);
    return @import("interp.zig").evalScript(std.mem.span(p), false);
}

fn noop(_: u32, _: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return rt.undefined_value;
}

// ---------------------------------------------------------------------- string methods

/// The runtime's String.prototype entry points take the argument types the compiler proved
/// (plan-notes 310); the interpreter proves nothing, so these do the coercions §22.1.3 does first.
const StringShim = enum(u8) { search_first, no_regexp, replace, replace_all, pad };

const string_shims = .{
    .{ "endsWith", StringShim.no_regexp },       .{ "includes", StringShim.no_regexp },
    .{ "startsWith", StringShim.no_regexp },     .{ "indexOf", StringShim.search_first },
    .{ "lastIndexOf", StringShim.search_first }, .{ "localeCompare", StringShim.search_first },
    .{ "replace", StringShim.replace },          .{ "replaceAll", StringShim.replace_all },
    .{ "padStart", StringShim.pad },             .{ "padEnd", StringShim.pad },
};

/// `s[key]` for the String.prototype methods that need a coercion, or null for the rest.
pub fn stringMethod(s: Value, key: [*:0]const u8) ?Value {
    const name = std.mem.span(key);
    inline for (string_shims) |row| {
        if (std.mem.eql(u8, name, row[0])) {
            const target = c.jsrt_get_prop(s, key, null);
            if (!rt.is(target, c.JSRT_TAG_CLOSURE)) return null;
            var frame: Frame(2) = .{};
            frame.open(.{ s, target });
            defer frame.pop();
            const env = c.jsrt_env_new(null, 3);
            env.*.slots()[0] = frame.slots[0];
            env.*.slots()[1] = frame.slots[1];
            env.*.slots()[2] = rt.number(@floatFromInt(@backingInt(row[1])));
            const arity: u32 = @intFromFloat(c.jsrt_to_number(c.jsrt_get_prop(target, "length", null)));
            return c.jsrt_closure_new(&stringShim, arity, row[0], env, true);
        }
    }
    return null;
}

fn stringShim(argc: u32, argv: [*c]const Value, env: [*c]Env) callconv(.c) Value {
    const slots = env.*.slots();
    const kind: StringShim = @fromBackingInt(@intCast(@as(u8, @intFromFloat(c.jsrt_to_number(slots[2])))));
    // receiver, target, then the two arguments the entry points take.
    var frame: Frame(4) = .{};
    frame.open(.{ slots[0], slots[1], arg(argc, argv, 0), arg(argc, argv, 1) });
    defer frame.pop();
    const a = &frame.slots;
    switch (kind) {
        .search_first => a[2] = c.jsrt_to_string(a[2]),
        .no_regexp => {
            if (c.jsrt_is_regexp(a[2])) {
                rt.throwType("First argument must not be a regular expression");
                return rt.undefined_value;
            }
            a[2] = c.jsrt_to_string(a[2]);
        },
        .pad => if (a[3] != rt.undefined_value) {
            a[3] = c.jsrt_to_string(a[3]);
        },
        .replace, .replace_all => {
            if (!c.jsrt_is_regexp(a[2])) {
                a[2] = c.jsrt_to_string(a[2]);
                if (rt.pending()) return rt.undefined_value;
                if (rt.is(a[3], c.JSRT_TAG_CLOSURE)) return replaceWith(a[0], a[2], a[3], kind == .replace_all);
            }
            if (!rt.is(a[3], c.JSRT_TAG_CLOSURE)) a[3] = c.jsrt_to_string(a[3]);
        },
    }
    if (rt.pending()) return rt.undefined_value;
    return vm.call(a[1], a[0], a[2..4]);
}

/// String.prototype.replace / replaceAll with a function replacement and a string pattern
/// (§22.1.3.19–20): one call per match, `fn(matched, position, string)`.
fn replaceWith(s: Value, pat: Value, f: Value, all: bool) Value {
    const len = c.jsrt_string_length(s);
    const pat_len = c.jsrt_string_length(pat);
    // s, pat, f, the result so far, the replacement just made.
    var frame: Frame(5) = .{};
    frame.open(.{ s, pat, f, rt.string(""), rt.undefined_value });
    defer frame.pop();
    const r = &frame.slots;
    var tail: u32 = 0;
    var from: u32 = 0;
    var matched = false;
    while (from <= len) {
        const hit_v = c.jsrt_string_index_of(r[0], r[1], rt.number(@floatFromInt(from)));
        const hit = c.jsrt_to_number(hit_v);
        if (hit < 0) break;
        const at: u32 = @intFromFloat(hit);
        r[4] = vm.call(r[2], rt.undefined_value, &.{ r[1], rt.number(hit), r[0] });
        if (rt.pending()) return rt.undefined_value;
        r[4] = c.jsrt_to_string(r[4]);
        if (rt.pending()) return rt.undefined_value;
        r[3] = c.jsrt_op_add(r[3], c.jsrt_string_slice(r[0], rt.number(@floatFromInt(tail)), rt.number(hit)));
        r[3] = c.jsrt_op_add(r[3], r[4]);
        matched = true;
        tail = at + pat_len;
        from = at + @max(pat_len, 1);
        if (!all) break;
    }
    if (!matched) return r[0];
    return c.jsrt_op_add(r[3], c.jsrt_string_slice(r[0], rt.number(@floatFromInt(tail)), rt.number(@floatFromInt(len))));
}

// ---------------------------------------------------------------------- prototype methods

/// The runtime keeps Array.prototype and String.prototype empty and finds a method on the
/// receiver by name, so `Array.prototype.map.call(xs, f)` reads undefined. These forward
/// `this` to the receiver's own method of the same name.
const array_methods = [_][:0]const u8{ "at", "concat", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast", "findLastIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push", "reduce", "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice", "toReversed", "toSorted", "toSpliced", "toString", "unshift", "values", "with" };
/// The ones that write to `this`: an array-like copied into an array would lose the writes.
const array_mutators = [_][:0]const u8{ "copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift" };
const string_methods = [_][:0]const u8{ "at", "charAt", "charCodeAt", "codePointAt", "concat", "endsWith", "includes", "indexOf", "lastIndexOf", "localeCompare", "match", "matchAll", "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll", "search", "slice", "split", "startsWith", "substring", "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase", "toString", "toUpperCase", "trim", "trimEnd", "trimStart", "valueOf" };

const ProtoKind = enum(u8) { array, string };

fn forwarders(proto: Value, comptime kind: ProtoKind, comptime names: []const [:0]const u8) void {
    inline for (names, 0..) |name, i| {
        const env = c.jsrt_env_new(null, 2);
        env.*.slots()[0] = rt.number(@floatFromInt(@backingInt(kind)));
        env.*.slots()[1] = rt.number(@floatFromInt(i));
        put(proto, name, c.jsrt_closure_new(&forward, 1, name, env, true));
    }
}

fn forward(argc: u32, argv: [*c]const Value, env: [*c]Env) callconv(.c) Value {
    const slots = env.*.slots();
    const kind: ProtoKind = @fromBackingInt(@intCast(@as(u8, @intFromFloat(c.jsrt_to_number(slots[0])))));
    const i: usize = @intFromFloat(c.jsrt_to_number(slots[1]));
    const this = if (argc > 0) argv[0] else rt.undefined_value;
    var frame: Frame(2) = .{};
    frame.open(.{ this, rt.undefined_value });
    defer frame.pop();
    const name = switch (kind) {
        .array => array_methods[i],
        .string => string_methods[i],
    };
    if (c.jsrt_is_nullish(this)) {
        var buf: [96]u8 = undefined;
        const msg = std.fmt.bufPrintSentinel(&buf, "{s}.prototype.{s} called on null or undefined", .{ if (kind == .array) "Array" else "String", name }, 0) catch "called on null or undefined";
        rt.throwType(msg.ptr);
        return rt.undefined_value;
    }
    switch (kind) {
        .string => if (!rt.is(this, c.JSRT_TAG_STRING)) {
            frame.slots[0] = c.jsrt_to_string(this);
        },
        .array => if (!rt.is(this, c.JSRT_TAG_ARRAY)) {
            for (array_mutators) |m| if (std.mem.eql(u8, m, name)) {
                rt.throwType("Array.prototype methods that write to an array-like are not supported by the interpreter yet");
                return rt.undefined_value;
            };
            frame.slots[0] = arrayLikeCopy(this);
        },
    }
    if (rt.pending()) return rt.undefined_value;
    frame.slots[1] = vm.getProp(frame.slots[0], name.ptr, null);
    if (rt.pending()) return rt.undefined_value;
    return vm.call(frame.slots[1], frame.slots[0], args(argc, argv));
}

/// An array holding `o[0] .. o[length - 1]`, holes for the missing indices.
fn arrayLikeCopy(o: Value) Value {
    var frame: Frame(2) = .{};
    frame.open(.{ o, c.jsrt_array_new(0, null) });
    defer frame.pop();
    const n = c.jsrt_to_number(vm.getProp(o, "length", null));
    if (rt.pending()) return rt.undefined_value;
    const len: f64 = if (std.math.isNan(n) or n <= 0) 0 else @min(@floor(n), 1 << 32);
    var k: f64 = 0;
    while (k < len) : (k += 1) {
        const v = vm.getElem(frame.slots[0], rt.number(k));
        if (rt.pending()) return rt.undefined_value;
        _ = c.jsrt_array_push(frame.slots[1], v);
    }
    return frame.slots[1];
}

// ---------------------------------------------------------------------- symbol keys

/// Symbols are interned strings that start with `__@` (populate), so the runtime's key walks
/// return them among the string keys; §20.1.2 splits the two.
fn isSymbolKey(k: Value) bool {
    if (!rt.is(k, c.JSRT_TAG_STRING)) return false;
    const p = c.jsrt_shape_key_ephemeral(k);
    defer std.c.free(p);
    return std.mem.startsWith(u8, std.mem.span(p), "__@");
}

fn keysWhere(keys: Value, symbols: bool) Value {
    if (rt.pending() or !rt.is(keys, c.JSRT_TAG_ARRAY)) return keys;
    var frame: Frame(2) = .{};
    frame.open(.{ keys, c.jsrt_array_new(0, null) });
    defer frame.pop();
    var i: usize = 0;
    while (i < vm.arrayItems(frame.slots[0]).len) : (i += 1) {
        const k = vm.arrayItems(frame.slots[0])[i];
        if (isSymbolKey(k) == symbols) _ = c.jsrt_array_push(frame.slots[1], k);
    }
    return frame.slots[1];
}

fn objectGetOwnPropertySymbols(argc: u32, argv: [*c]const Value, _: [*c]Env) callconv(.c) Value {
    return keysWhere(c.jsrt_object_get_own_property_names(reflectTarget(arg(argc, argv, 0))), true);
}
