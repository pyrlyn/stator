//! The value allocation helpers jsrt_value.h declares: fixed-layout objects, arrays and their
//! growth, closure environments, closures, rest arrays and dynamic objects, and the collector
//! kinds that say what each of them references (jsrt_gc.zig). Every jsrt_value slot is
//! `undefined` before the caller can see the block, so a trace never reads a word that was not
//! stored as a value.

const std = @import("std");
const mem = @import("jsrt_mem.zig");
const gc = @import("jsrt_gc.zig");
const shapes = @import("jsrt_shape.zig");
const c = mem.c;

const Value = c.jsrt_value;
const undefined_value: Value = c.JSRT_UNDEFINED;

fn create(comptime T: type, bytes: usize, kind: *const gc.Kind) *T {
    return @ptrCast(@alignCast(gc.alloc(bytes, kind)));
}

fn traceObject(o: *c.JSRTObject, visit: c.jsrt_gc_visit_fn) void {
    gc.visitValues(o.fields()[0..o.cls.*.field_count], visit);
    visit.?(o.extras);
}

fn traceArray(a: *c.JSRTArray, visit: c.jsrt_gc_visit_fn) void {
    // NULL while jsrt_array_new allocates the first buffer, which may collect.
    if (a.elements != null) gc.visitValues(a.elements[0..a.capacity], visit);
    if (a.slots != null) gc.visitValues(a.slots[0..a.slot_capacity], visit);
}

fn finalizeArray(a: *c.JSRTArray) void {
    gc.bufferFree(a.elements);
    gc.bufferFree(a.slots);
}

fn traceEnv(env: *c.JSRTEnv, visit: c.jsrt_gc_visit_fn) void {
    visit.?(env.parent);
    gc.visitValues(env.slots()[0..env.count], visit);
}

fn traceClosure(closure: *c.JSRTClosure, visit: c.jsrt_gc_visit_fn) void {
    visit.?(closure.env);
    gc.visitValue(closure.prototype, visit);
    visit.?(closure.props);
}

fn traceDynobj(o: *c.JSRTDynObject, visit: c.jsrt_gc_visit_fn) void {
    if (o.slots != null) gc.visitValues(o.slots[0..o.capacity], visit);
    gc.visitValue(o.proto, visit);
    gc.visitValue(o.ctor, visit);
}

fn finalizeDynobj(o: *c.JSRTDynObject) void {
    gc.bufferFree(o.slots);
}

const object_kind = gc.kind(c.JSRTObject, "object", traceObject, null, .{});
const array_kind = gc.kind(c.JSRTArray, "array", traceArray, finalizeArray, .{});
// Generated code stores captured variables straight into the slots (JSRT_ENV_AT).
const env_kind = gc.kind(c.JSRTEnv, "closure environment", traceEnv, null, .{ .always_dirty = true });
const closure_kind = gc.kind(c.JSRTClosure, "closure", traceClosure, null, .{});
const dynobj_kind = gc.kind(c.JSRTDynObject, "dynamic object", traceDynobj, finalizeDynobj, .{});

/// An array's element buffer. Split from the header because the array grows: `elements` is
/// replaced where the header is not.
fn elements(owner: ?*const c.JSRTArray, capacity: u32) [*]Value {
    const bytes = @as(usize, capacity) * @sizeOf(Value);
    return @ptrCast(@alignCast(gc.buffer(owner, bytes, "array elements")));
}

/// One allocation, header and slots together: the flexible member is safe because an object's slot
/// count never changes (see the comment on JSRTObject).
export fn jsrt_object_new(cls: *const c.JSRTClass) Value {
    const bytes = @sizeOf(c.JSRTObject) + @as(usize, cls.field_count) * @sizeOf(Value);
    const object = create(c.JSRTObject, bytes, &object_kind);
    object.cls = cls;
    object.frozen = false;
    object.extras = null;
    @memset(object.fields()[0..cls.field_count], undefined_value);
    return c.JSRT_BOX(c.JSRT_TAG_OBJECT, @intFromPtr(object));
}

pub export fn jsrt_array_new(count: u32, items: [*c]const Value) Value {
    const array = create(c.JSRTArray, @sizeOf(c.JSRTArray), &array_kind);
    // An empty literal still gets a one-element buffer, so `elements` is never NULL and every path
    // can index it without a null test.
    const capacity: u32 = if (count > 0) count else 1;
    const buf = elements(array, capacity);
    if (count > 0) @memcpy(buf[0..count], items[0..count]);
    @memset(buf[count..capacity], undefined_value);
    // No named-property table until something hangs a property off this array (a RegExp match is
    // the only thing that does today), which is what NULL means to the shape table.
    array.* = .{
        .length = count,
        .capacity = capacity,
        .elements = buf,
        .shape = null,
        .slots = null,
        .slot_capacity = 0,
    };
    return c.JSRT_BOX(c.JSRT_TAG_ARRAY, @intFromPtr(array));
}

/// Doubles until `index` fits, so repeated appends stay amortized O(1) rather than O(n) per push.
/// Widened to 64 bits because doubling a capacity near UINT32_MAX would wrap to zero and spin
/// forever; an index that high is a request the allocator would refuse anyway.
export fn jsrt_array_grow(a: *c.JSRTArray, index: u32) void {
    var capacity: u64 = a.capacity;
    while (capacity <= index) capacity *= 2;
    if (capacity > std.math.maxInt(u32)) c.jsrt_panic("array index too large");
    const grown: u32 = @intCast(capacity);
    const buf = elements(a, grown);
    @memcpy(buf[0..a.length], a.elements[0..a.length]);
    @memset(buf[a.length..grown], undefined_value);
    gc.write(a);
    // A caller may still hold a pointer into the old elements.
    gc.bufferRetire(a.elements);
    a.elements = buf;
    a.capacity = grown;
}

pub export fn jsrt_env_new(parent: ?*c.JSRTEnv, count: u32) *c.JSRTEnv {
    const bytes = @sizeOf(c.JSRTEnv) + @as(usize, count) * @sizeOf(Value);
    const env = create(c.JSRTEnv, bytes, &env_kind);
    env.parent = parent;
    env.count = count;
    @memset(env.slots()[0..count], undefined_value);
    return env;
}

export fn jsrt_env_clone(env: ?*c.JSRTEnv) ?*c.JSRTEnv {
    const src = env orelse return null;
    const copy = jsrt_env_new(src.parent, src.count);
    @memcpy(copy.slots()[0..src.count], src.slots()[0..src.count]);
    return copy;
}

export fn jsrt_env_copy_slots(dst: ?*c.JSRTEnv, src: ?*const c.JSRTEnv) void {
    const to = dst orelse return;
    const from = src orelse return;
    const n = @min(to.count, from.count);
    // copyForwards rather than @memcpy: nothing forbids committing an environment onto itself.
    std.mem.copyForwards(Value, to.slots()[0..n], from.slots()[0..n]);
}

pub export fn jsrt_closure_new(
    func: @FieldType(c.JSRTClosure, "fn"),
    arity: u32,
    name: [*c]const u8,
    env: ?*c.JSRTEnv,
    has_receiver: bool,
) Value {
    const closure = create(c.JSRTClosure, @sizeOf(c.JSRTClosure), &closure_kind);
    closure.* = .{
        .@"fn" = func,
        .arity = arity,
        .name = name,
        .env = env,
        .has_receiver = has_receiver,
        // A heap closure is never a class object: class objects are file-scope constants the
        // emitter writes with their descriptor (docs/VALUE.md §4.17).
        .klass = null,
        .constructible = false,
        .has_prototype = false,
        .prototype = 0,
        .props = null,
    };
    return c.jsrt_closure(closure);
}

/// Marks a fresh heap closure as a capturing `function`, one `new` builds through (plan-notes 310).
pub export fn jsrt_closure_constructible(value: Value) Value {
    const closure: *c.JSRTClosure = @ptrCast(@alignCast(c.jsrt_ptr(value)));
    closure.constructible = true;
    return value;
}

export fn jsrt_args_rest(argc: u32, argv: [*c]const Value, from: u32) Value {
    if (from >= argc) return jsrt_array_new(0, null);
    return jsrt_array_new(argc - from, argv + from);
}

fn dynobjNew(cls: *const c.JSRTClass) Value {
    const o = create(c.JSRTDynObject, @sizeOf(c.JSRTDynObject), &dynobj_kind);
    o.* = .{
        .cls = cls,
        .shape = &shapes.jsrt_shape_root,
        .capacity = 0,
        .slots = null,
        .frozen = false,
        .proto = 0,
        .ctor = 0,
    };
    return c.JSRT_BOX(c.JSRT_TAG_OBJECT, @intFromPtr(o));
}

export fn jsrt_dynobj_new() Value {
    return dynobjNew(&c.jsrt_class_dynamic);
}

export fn jsrt_null_proto_new() Value {
    return dynobjNew(&c.jsrt_class_null_proto);
}
