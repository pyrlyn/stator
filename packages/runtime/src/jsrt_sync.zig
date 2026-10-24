//! Handles share one native monitor. Predicate state is protected, values remain GC-visible.
const std = @import("std");
const common = @import("jsrt_concurrent.zig");
const gc = @import("jsrt_gc.zig");
const c = common.c;
const Value = common.Value;
const mutex_class = common.descriptor("StatorMutex");
const cond_class = common.descriptor("StatorCondVar");
const channel_class = common.descriptor("StatorChannel");
var gate: std.c.pthread_mutex_t = .{};
var changed: std.c.pthread_cond_t = .{};

const Mutex = struct {
    cls: *const c.JSRTClass = &mutex_class,
    owner: ?std.c.pthread_t = null,
    waiters: usize = 0,
    destroyed: bool = false,
};
const Waiter = struct { signaled: bool = false, next: ?*Waiter };
const Condition = struct {
    cls: *const c.JSRTClass = &cond_class,
    waiters: ?*Waiter = null,
    destroyed: bool = false,
};
const Channel = struct {
    cls: *const c.JSRTClass = &channel_class,
    values: []Value,
    head: usize = 0,
    count: usize = 0,
    closed: bool = false,
};

// Failure allocates an Error, so leave the monitor before entering the runtime.
fn finish(message: ?[*:0]const u8) void {
    common.unlock(&gate);
    if (message) |text| common.fail(text);
}
fn notify() void {
    common.wake(&changed);
    finish(null);
}
fn locked(comptime T: type, value: Value, cls: *const c.JSRTClass) ?*T {
    const item = common.handle(T, value, cls) orelse return null;
    common.lock(&gate);
    if (@hasField(T, "destroyed")) {
        if (item.destroyed) {
            finish("std/sync.handle(): EINVAL");
            return null;
        }
    }
    return item;
}
fn destroy(item: anytype, busy: bool) void {
    if (busy) {
        finish("std/sync.destroy(): EBUSY");
        return;
    }
    item.destroyed = true;
    finish(null);
}
fn owned(mutex: *Mutex) bool {
    return if (mutex.owner) |owner| owner == std.c.pthread_self() else false;
}
fn acquire(mutex: *Mutex) ?[*:0]const u8 {
    if (owned(mutex)) return "std/sync.Mutex.lock(): EDEADLK";
    mutex.waiters += 1;
    defer mutex.waiters -= 1;
    while (mutex.owner != null) common.wait(&changed, &gate);
    mutex.owner = std.c.pthread_self();
    return null;
}
export fn jsrt_sync_mutex_new() Value {
    return common.create(Mutex, .{});
}
export fn jsrt_sync_mutex_lock(value: Value) void {
    const mutex = locked(Mutex, value, &mutex_class) orelse return;
    finish(acquire(mutex));
}
export fn jsrt_sync_mutex_try_lock(value: Value) bool {
    const mutex = locked(Mutex, value, &mutex_class) orelse return false;
    const available = mutex.owner == null;
    if (available) mutex.owner = std.c.pthread_self();
    finish(null);
    return available;
}
export fn jsrt_sync_mutex_unlock(value: Value) void {
    const mutex = locked(Mutex, value, &mutex_class) orelse return;
    if (mutex.destroyed or !owned(mutex)) {
        finish("std/sync.Mutex.unlock(): EPERM");
        return;
    }
    mutex.owner = null;
    notify();
}
export fn jsrt_sync_mutex_destroy(value: Value) void {
    const mutex = locked(Mutex, value, &mutex_class) orelse return;
    destroy(mutex, mutex.owner != null or mutex.waiters != 0);
}
export fn jsrt_sync_cond_new() Value {
    return common.create(Condition, .{});
}
export fn jsrt_sync_cond_wait(value: Value, mutex_value: Value) void {
    const condition = common.handle(Condition, value, &cond_class) orelse return;
    const mutex = common.handle(Mutex, mutex_value, &mutex_class) orelse return;
    common.lock(&gate);
    if (condition.destroyed or mutex.destroyed or !owned(mutex)) {
        finish("std/sync.CondVar.wait(): EPERM");
        return;
    }
    var waiter: Waiter = .{ .next = condition.waiters };
    condition.waiters = &waiter;
    // Counts the condition wait too: the mutex must not be destroyed while temporarily released.
    mutex.waiters += 1;
    mutex.owner = null;
    common.wake(&changed);
    while (!waiter.signaled) common.wait(&changed, &gate);
    var link = &condition.waiters;
    while (link.*) |entry| {
        if (entry == &waiter) {
            link.* = entry.next;
            break;
        }
        link = &entry.next;
    }
    while (mutex.owner != null) common.wait(&changed, &gate);
    mutex.owner = std.c.pthread_self();
    mutex.waiters -= 1;
    finish(null);
}
export fn jsrt_sync_cond_signal(value: Value, all: bool) void {
    const condition = locked(Condition, value, &cond_class) orelse return;
    var entry = condition.waiters;
    while (entry) |waiter| : (entry = waiter.next) {
        if (!waiter.signaled) {
            waiter.signaled = true;
            if (!all) break;
        }
    }
    notify();
}
export fn jsrt_sync_cond_destroy(value: Value) void {
    const condition = locked(Condition, value, &cond_class) orelse return;
    destroy(condition, condition.waiters != null);
}
export fn jsrt_sync_channel_new(capacity: f64) Value {
    if (!std.math.isFinite(capacity) or capacity < 1 or capacity > 1048576 or @trunc(capacity) != capacity) {
        common.fail("std/sync.Channel(): EINVAL");
        return c.JSRT_UNDEFINED;
    }
    const channel = common.allocate(Channel);
    const n: usize = @intFromFloat(capacity);
    channel.* = .{ .values = &.{} };
    var roots: common.Roots(1) = undefined;
    roots.open(.{common.box(channel)});
    defer roots.pop();
    const values: [*]Value = @ptrCast(@alignCast(gc.alloc(n * @sizeOf(Value), "channel buffer")));
    channel.values = values[0..n];
    @memset(channel.values, c.JSRT_UNDEFINED);
    return roots.slots[0];
}
export fn jsrt_sync_channel_send(handle: Value, value: Value) void {
    const channel = locked(Channel, handle, &channel_class) orelse return;
    while (!channel.closed and channel.count == channel.values.len) common.wait(&changed, &gate);
    if (channel.closed) {
        finish("std/sync.Channel.send(): EPIPE");
        return;
    }
    channel.values[(channel.head + channel.count) % channel.values.len] = value;
    channel.count += 1;
    notify();
}
export fn jsrt_sync_channel_receive(value: Value) Value {
    const channel = locked(Channel, value, &channel_class) orelse return c.JSRT_UNDEFINED;
    while (!channel.closed and channel.count == 0) common.wait(&changed, &gate);
    if (channel.count == 0) {
        finish("std/sync.Channel.receive(): EPIPE");
        return c.JSRT_UNDEFINED;
    }
    const item = gc.jsrt_gc_handoff(channel.values[channel.head]);
    channel.values[channel.head] = c.JSRT_UNDEFINED;
    channel.head = (channel.head + 1) % channel.values.len;
    channel.count -= 1;
    notify();
    return item;
}
export fn jsrt_sync_channel_close(value: Value) void {
    const channel = locked(Channel, value, &channel_class) orelse return;
    channel.closed = true;
    notify();
}
