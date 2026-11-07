//! Shared pthread and boxed-handle operations; no private copies of runtime value layouts.
const std = @import("std");
const mem = @import("jsrt_mem.zig");
const gc = @import("jsrt_gc.zig");
pub const c = mem.c;
pub const Value = c.jsrt_value;

// A thread waiting here cannot reach a safepoint, so it counts as stopped for a collection
// meanwhile (jsrt_gc.zig enterBlocking); the holder may be the thread that is collecting.
pub fn lock(mutex: *std.c.pthread_mutex_t) void {
    if (std.c.pthread_mutex_trylock(mutex) == .SUCCESS) return;
    gc.enterBlocking();
    defer gc.leaveBlocking();
    if (std.c.pthread_mutex_lock(mutex) != .SUCCESS) c.jsrt_panic("pthread mutex lock failed");
}
pub fn unlock(mutex: *std.c.pthread_mutex_t) void {
    if (std.c.pthread_mutex_unlock(mutex) != .SUCCESS) c.jsrt_panic("pthread mutex unlock failed");
}
pub fn wait(condition: *std.c.pthread_cond_t, mutex: *std.c.pthread_mutex_t) void {
    gc.enterBlocking();
    defer gc.leaveBlocking();
    if (std.c.pthread_cond_wait(condition, mutex) != .SUCCESS) c.jsrt_panic("pthread condition wait failed");
}
pub fn wake(condition: *std.c.pthread_cond_t) void {
    if (std.c.pthread_cond_broadcast(condition) != .SUCCESS) c.jsrt_panic("pthread condition broadcast failed");
}
pub fn fail(message: [*:0]const u8) void {
    c.jsrt_throw_error(&c.jsrt_class_error, message);
}
pub const descriptor = mem.classDescriptor;
pub fn allocate(comptime T: type, kind: *const gc.Kind) *T {
    return @ptrCast(@alignCast(gc.alloc(@sizeOf(T), kind)));
}
pub fn box(ptr: anytype) Value {
    return c.JSRT_BOX(c.JSRT_TAG_OBJECT, @intFromPtr(ptr));
}
pub fn handle(comptime T: type, value: Value, cls: *const c.JSRTClass) ?*T {
    if (!c.jsrt_is(value, c.JSRT_TAG_OBJECT) or c.jsrt_as_object(value).*.cls != cls) {
        fail("std/sync.handle(): EINVAL");
        return null;
    }
    return @ptrCast(@alignCast(c.jsrt_ptr(value)));
}
pub fn create(comptime T: type, initial: T, kind: *const gc.Kind) Value {
    const value = allocate(T, kind);
    value.* = initial;
    return box(value);
}
pub const Roots = mem.Frame;
