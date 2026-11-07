//! The interpreter's realm (docs/INTERPRETER.md §3): the global object and the global lexical
//! environment a script's free names resolve in. The runtime has neither — compiled code names
//! its globals at compile time — so the interpreter keeps its own, one per process.

const std = @import("std");
const c = @import("jsrt");
const gc = @import("gc.zig");
const vm = @import("vm.zig");

const Value = c.jsrt_value;

pub const Realm = struct {
    global: Value,
    /// `let`, `const` and `class` at the top of a script, keyed by interned name.
    lexical: std.AutoHashMapUnmanaged([*:0]const u8, Lexical) = .empty,
    /// The intrinsic error constructors, which `constructor` answers for the runtime's error
    /// objects whatever the global names hold now.
    errors: [error_names.len]ErrorCtor = undefined,
    /// The interned `constructor` key, for the comparison `get_field` makes on every read.
    constructor_key: [*:0]const u8 = undefined,
};

const ErrorCtor = struct { cls: *const c.JSRTClass, ctor: Value };

const error_names = [_][*:0]const u8{ "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError" };

pub const Lexical = struct {
    /// The hole while the binding is in its TDZ.
    value: Value,
    constant: bool,
};

/// Collected memory behind a raw pointer: the collector scans static data conservatively, which
/// finds a raw pointer but not a boxed value, and the block itself is traced with the mask.
var current: ?*Realm = null;

pub fn get() *Realm {
    if (current) |r| return r;
    const r = gc.allocator.create(Realm) catch unreachable;
    r.* = .{ .global = c.jsrt_dynobj_new() };
    current = r;
    install(r);
    return r;
}

/// The global object's own properties: the value properties of ECMA-262 §19.1 and the
/// constructors the runtime can hand out as values.
fn install(r: *Realm) void {
    const g = r.global;
    put(g, "globalThis", g);
    put(g, "NaN", c.jsrt_number(std.math.nan(f64)));
    put(g, "Infinity", c.jsrt_number(std.math.inf(f64)));
    for ([_][*:0]const u8{
        "Object",  "Array",   "Boolean",     "Number",   "String",     "Date",    "RegExp",   "Map", "Set",
        "WeakMap", "WeakSet", "ArrayBuffer", "DataView", "Uint8Array", "Promise", "Function",
    }) |name| put(g, name, c.jsrt_builtin_ctor(name));
    for (error_names, &r.errors) |name, *e| {
        const cls = c.jsrt_error_class(name) orelse unreachable;
        e.* = .{ .cls = cls, .ctor = errorCtorNew(cls, name) };
        put(g, name, e.ctor);
    }
    r.constructor_key = intern("constructor");
}

/// The runtime's error classes are descriptors, not values: compiled code names them statically.
/// The interpreter's constructor for one is a closure whose environment holds the descriptor.
fn errorCtorNew(cls: *const c.JSRTClass, name: [*:0]const u8) Value {
    const own = c.jsrt_env_new(null, 1);
    vm.slots(own)[0] = @intFromPtr(cls);
    return c.jsrt_closure_constructible(c.jsrt_closure_new(errorCtor, 1, name, own, true));
}

/// `Error(message)` and `new Error(message)` alike (§20.5.1.1): `new` keeps the object the
/// constructor returns, so the `this` it passes is unused.
fn errorCtor(argc: u32, argv: [*c]const Value, env: [*c]c.JSRTEnv) callconv(.c) Value {
    const cls: *const c.JSRTClass = @ptrFromInt(vm.slots(env)[0]);
    const message = if (argc > 1 and argv[1] != c.JSRT_UNDEFINED) c.jsrt_to_string(argv[1]) else c.jsrt_string_from_utf8("", 0);
    if (c.jsrt_pending()) return c.JSRT_UNDEFINED;
    return c.jsrt_error_new(cls, message);
}

/// `obj.constructor` when `obj` is one of the runtime's error objects. The runtime has no value for
/// an error's constructor (compiled code names error classes statically) and panics on the read.
pub fn errorConstructor(r: *const Realm, obj: Value) ?Value {
    if (!c.jsrt_is_error(obj)) return null;
    const cls = c.jsrt_as_object(obj).*.cls;
    for (r.errors) |e| if (e.cls == cls) return e.ctor;
    unreachable;
}

/// The error class `ctor` constructs, when it is one of the realm's error constructors.
pub fn errorClass(ctor: Value) ?*const c.JSRTClass {
    if (!c.jsrt_is(ctor, c.JSRT_TAG_CLOSURE)) return null;
    const closure = c.jsrt_as_closure(ctor);
    if (closure.*.@"fn" != &errorCtor) return null;
    return @ptrFromInt(vm.slots(closure.*.env)[0]);
}

fn put(obj: Value, key: [*:0]const u8, v: Value) void {
    c.jsrt_set_prop(obj, intern(key), v, null);
}

fn intern(key: [*:0]const u8) [*:0]const u8 {
    return @ptrCast(c.jsrt_shape_key(nameValue(key)));
}

/// An interned name as a string value.
pub fn nameValue(key: [*:0]const u8) Value {
    return c.jsrt_string_from_utf8(key, std.mem.len(key));
}
