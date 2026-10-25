//! OS workers publish to main; only main touches Promise state or drains microtasks.
const std = @import("std");
const common = @import("jsrt_concurrent.zig");
const gc = @import("jsrt_gc.zig");
const stack = @import("jsrt_stack.zig");
const c = common.c;
const Value = common.Value;
const thread_class = common.descriptor("StatorThread");
const Event = struct {
    cls: *const c.JSRTClass = &thread_class,
    work: Value,
    cleanup: Value = c.JSRT_UNDEFINED,
    promise: Value = c.JSRT_UNDEFINED,
    value: Value = c.JSRT_UNDEFINED,
    rejected: bool = false,
    callback: bool = false,
    pooled: bool = false,
    thread: std.c.pthread_t = undefined,
    next: ?*Event = null,
    active_next: ?*Event = null,
};
var gate: std.c.pthread_mutex_t = .{};
var changed: std.c.pthread_cond_t = .{};
var first: ?*Event = null;
var last: ?*Event = null;
var active: ?*Event = null;
const pool_limit = 4;
var pool_threads: [pool_limit]std.c.pthread_t = undefined;
var pool_count: usize = 0;
var pool_started: usize = 0;
var pool_pending: usize = 0;
var pool_first: ?*Event = null;
var pool_last: ?*Event = null;
var pool_stopping = false;
threadlocal var worker = false;

// Internal lifecycle probe: counts successful OS worker creation, not submitted jobs.
export fn jsrt_thread_pool_started() f64 {
    return @floatFromInt(pool_started);
}

export fn jsrt_thread_is_worker() bool {
    return worker;
}

export fn jsrt_thread_require_main() void {
    if (worker) common.fail("std/thread.promise(): EPERM");
}

fn append(head: *?*Event, tail: *?*Event, event: *Event) void {
    if (tail.*) |item| item.next = event else head.* = event;
    tail.* = event;
}

fn take(head: *?*Event, tail: *?*Event) ?*Event {
    const event = head.* orelse return null;
    head.* = event.next;
    if (head.* == null) tail.* = null;
    event.next = null;
    return event;
}

fn post(event: *Event) void {
    common.lock(&gate);
    defer common.unlock(&gate);
    if (event.pooled) pool_pending -= 1;
    append(&first, &last, event);
    common.wake(&changed);
}

fn enterWorker() void {
    gc.enterThread();
    worker = true;
    stack.jsrt_stack_init();
}

fn execute(event: *Event) void {
    var roots: common.Roots(2) = .{};
    roots.open(.{ event.work, c.JSRT_UNDEFINED });
    const done = c.jsrt_call_protected(roots.slots[0], 0, null);
    roots.slots[1] = done.value;
    event.value = roots.slots[1];
    event.rejected = done.threw;
    if (!done.threw and c.jsrt_is_promise(done.value)) {
        common.fail("std/thread.spawn(): EINVAL");
        event.value = c.jsrt_take_exception();
        event.rejected = true;
    }
    _ = c.jsrt_call_protected(event.cleanup, 0, null);
    // Publication happens while both the active list and this thread's roots keep values live.
    post(event);
    roots.pop();
    // A reused worker must not retain the previous job's transient roots while idle.
    gc.jsrt_gc_safepoint();
}

fn run(raw: ?*anyopaque) callconv(.c) ?*anyopaque {
    enterWorker();
    defer gc.leaveThread();
    execute(@ptrCast(@alignCast(raw.?)));
    return null;
}

fn runPool(_: ?*anyopaque) callconv(.c) ?*anyopaque {
    enterWorker();
    defer gc.leaveThread();
    while (true) {
        common.lock(&gate);
        while (pool_first == null and !pool_stopping) common.wait(&changed, &gate);
        const event = take(&pool_first, &pool_last);
        common.unlock(&gate);
        execute(event orelse return null);
    }
}

// Main holds gate; workers cannot observe a job until its active-list root is published.
fn enqueue(event: *Event) bool {
    if (pool_pending >= pool_count and pool_count < pool_limit) {
        if (std.c.pthread_create(&pool_threads[pool_count], null, runPool, null) == .SUCCESS) {
            pool_count += 1;
            pool_started += 1;
        } else if (pool_count == 0) return false;
    }
    pool_pending += 1;
    append(&pool_first, &pool_last, event);
    common.wake(&changed);
    return true;
}

fn joinWorker(thread: std.c.pthread_t) void {
    if (std.c.pthread_join(thread, null) != .SUCCESS) c.jsrt_panic("thread join failed");
}

export fn jsrt_thread_spawn(work: Value, cleanup: Value, pooled: bool) Value {
    if (worker or !c.jsrt_is(work, c.JSRT_TAG_CLOSURE) or !c.jsrt_is(cleanup, c.JSRT_TAG_CLOSURE)) {
        common.fail("std/thread.spawn(): EINVAL");
        return c.JSRT_UNDEFINED;
    }
    gc.enableThreads();
    var roots: common.Roots(3) = undefined;
    roots.open(.{ work, c.JSRT_UNDEFINED, cleanup });
    defer roots.pop();
    const event = common.allocate(Event);
    event.* = .{ .work = roots.slots[0], .cleanup = roots.slots[2], .pooled = pooled };
    roots.slots[1] = common.box(event);
    event.promise = c.jsrt_promise_new();
    common.lock(&gate);
    event.active_next = active;
    active = event;
    const started = if (pooled) enqueue(event) else std.c.pthread_create(&event.thread, null, run, event) == .SUCCESS;
    if (!started) active = event.active_next;
    common.unlock(&gate);
    if (!started) {
        common.fail("std/thread.spawn(): EAGAIN");
        return c.JSRT_UNDEFINED;
    }
    return roots.slots[1];
}

export fn jsrt_thread_join(value: Value) Value {
    if (worker) {
        common.fail("std/thread.join(): EPERM");
        return c.JSRT_UNDEFINED;
    }
    const event = common.handle(Event, value, &thread_class) orelse return c.JSRT_UNDEFINED;
    return event.promise;
}

export fn jsrt_thread_run_on_main(work: Value) void {
    if (!c.jsrt_is(work, c.JSRT_TAG_CLOSURE)) {
        common.fail("std/thread.runOnMain(): EINVAL");
        return;
    }
    const event = common.allocate(Event);
    event.* = .{ .work = work, .callback = true };
    post(event);
}

/// Called only when the ordinary microtask queue is empty. No allocation while gate is held.
export fn jsrt_thread_poll() bool {
    if (worker) c.jsrt_panic("worker attempted to drain microtasks");
    common.lock(&gate);
    while (first == null and active != null) common.wait(&changed, &gate);
    const event = take(&first, &last) orelse {
        // Only quiescence ends the pool: Promise continuations may submit the next wave.
        pool_stopping = true;
        common.wake(&changed);
        common.unlock(&gate);
        for (pool_threads[0..pool_count]) |thread| joinWorker(thread);
        pool_count = 0;
        pool_stopping = false;
        return false;
    };
    var roots: common.Roots(1) = undefined;
    roots.open(.{common.box(event)});
    defer roots.pop();
    if (!event.callback) {
        var link = &active;
        while (link.*) |item| {
            if (item == event) {
                link.* = event.active_next;
                break;
            }
            link = &item.active_next;
        }
        event.active_next = null;
    }
    common.unlock(&gate);
    if (event.callback) {
        const result = c.jsrt_call_protected(event.work, 0, null);
        if (result.threw) c.jsrt_throw(result.value);
    } else {
        if (!event.pooled) joinWorker(event.thread);
        c.jsrt_promise_settle(event.promise, event.value, event.rejected);
    }
    event.work = c.JSRT_UNDEFINED;
    event.cleanup = c.JSRT_UNDEFINED;
    event.value = c.JSRT_UNDEFINED;
    return true;
}
