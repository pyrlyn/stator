//! Native stack overflow is Node's error, not a SIGSEGV (plan.md §9 Task 6.23, F6).
//!
//! Two layers. The first is the guard every generated function opens with (JSRT_STACK_CHECK in
//! jsrt_value.h): its frame address against `jsrt_stack_limit`, which `jsrt_stack_init` sets from
//! the thread's real stack bounds. Past it the call throws Node's catchable
//! `RangeError: Maximum call stack size exceeded` instead of recursing. The limit sits `headroom`
//! above the stack's low end, so the runtime code the deepest frame still calls (printing, the
//! throw itself, a catch handler's console.log) has stack left to run on.
//!
//! The second layer is for recursion no prologue sees: the runtime's own C recursion over deeply
//! nested data (JSON.stringify of a million-deep array). A SIGSEGV or SIGBUS whose fault address is
//! at the stack's low end runs on an alternate signal stack and prints the loud runtime refusal
//! `PANIC: STA2005 stack overflow` with the shadow-stack depth, as jsrt_panic does. Any other fault
//! is not ours: the handler reinstalls whatever was there before (the default action, ASan's
//! reporter, a host program's handler) and returns, so the faulting instruction re-runs into it.

const std = @import("std");
const builtin = @import("builtin");
const mem = @import("jsrt_mem.zig");
const c = mem.c;

/// See jsrt_value.h. Thread-local because the bounds are per thread: a limit taken from one
/// thread's stack is meaningless on another's.
export threadlocal var jsrt_stack_limit: usize = 0;

/// Stack kept free below the limit for runtime code. A generated frame is a few hundred bytes; the
/// runtime's widest callees (printing, number formatting, the error constructor) stay well under
/// this.
const headroom: usize = 256 * 1024;

/// How far below the stack's low end a fault still counts as overflow: the guard region, plus a
/// frame large enough to step over it.
const below_slop: usize = 1024 * 1024;

/// A main-thread stack whose limit is "unlimited" reports an absurd size; trust no more than this.
const max_stack: usize = 1024 * 1024 * 1024;

/// The low end of the stack jsrt_stack_init measured (the thread that ran jsrt_init). The fault
/// handler reads it, so it is a plain global, not thread-local.
var stack_low: usize = 0;

/// The handler cannot run on the stack that just overflowed.
var alt_stack: [128 * 1024]u8 align(16) = undefined;

var installed = false;
var previous_segv: std.c.Sigaction = undefined;
var previous_bus: std.c.Sigaction = undefined;

fn sigNumber(sig: anytype) c_int {
    return switch (@typeInfo(@TypeOf(sig))) {
        .@"enum" => @intCast(@intFromEnum(sig)),
        else => @intCast(sig),
    };
}

const sig_segv = sigNumber(std.c.SIG.SEGV);
const sig_bus = sigNumber(std.c.SIG.BUS);

extern "c" fn sigaction(sig: c_int, noalias act: ?*const std.c.Sigaction, noalias old: ?*std.c.Sigaction) c_int;
extern "c" fn sigaltstack(noalias ss: ?*const std.c.stack_t, noalias old: ?*std.c.stack_t) c_int;
extern "c" fn pthread_get_stackaddr_np(thread: std.c.pthread_t) ?*anyopaque;
extern "c" fn pthread_get_stacksize_np(thread: std.c.pthread_t) usize;
extern "c" fn pthread_getattr_np(thread: std.c.pthread_t, attr: *std.c.pthread_attr_t) c_int;
extern "c" fn pthread_attr_getstack(attr: *const std.c.pthread_attr_t, addr: *?*anyopaque, size: *usize) c_int;
extern "c" fn pthread_attr_destroy(attr: *std.c.pthread_attr_t) c_int;

const Bounds = struct { low: usize, high: usize };

/// The calling thread's stack as [low, high), or null where this platform gives no way to ask.
fn currentBounds() ?Bounds {
    const self = std.c.pthread_self();
    switch (builtin.os.tag) {
        .macos, .ios, .tvos, .watchos, .visionos => {
            const high = @intFromPtr(pthread_get_stackaddr_np(self) orelse return null);
            const size = @min(pthread_get_stacksize_np(self), max_stack);
            if (size == 0 or size > high) return null;
            return .{ .low = high - size, .high = high };
        },
        .linux => {
            var attr: std.c.pthread_attr_t = undefined;
            if (pthread_getattr_np(self, &attr) != 0) return null;
            defer _ = pthread_attr_destroy(&attr);
            var addr: ?*anyopaque = null;
            var size: usize = 0;
            if (pthread_attr_getstack(&attr, &addr, &size) != 0) return null;
            const low = @intFromPtr(addr orelse return null);
            if (size == 0) return null;
            const high = low + size;
            return .{ .low = if (size > max_stack) high - max_stack else low, .high = high };
        },
        else => return null,
    }
}

/// Called from jsrt_init. Safe to call again (a second `stator_<unit>_init`, another thread): the
/// limit is re-measured for the calling thread, and the handler is installed once per process.
pub export fn jsrt_stack_init() void {
    const bounds = currentBounds() orelse return;
    if (bounds.high - bounds.low <= 2 * headroom) return;
    jsrt_stack_limit = bounds.low + headroom;
    if (installed) return;
    installed = true;
    stack_low = bounds.low;
    installFaultHandler();
}

fn installFaultHandler() void {
    // An alternate stack someone already set (ASan sets its own) is kept: replacing it would leave
    // their handler on ours.
    var current: std.c.stack_t = undefined;
    if (sigaltstack(null, &current) != 0) return;
    if (current.flags & std.c.SS.DISABLE != 0) {
        const ours: std.c.stack_t = .{ .sp = &alt_stack, .size = alt_stack.len, .flags = 0 };
        if (sigaltstack(&ours, null) != 0) return;
    }
    var action = std.mem.zeroes(std.c.Sigaction);
    action.handler = .{ .sigaction = onFault };
    action.flags = std.c.SA.SIGINFO | std.c.SA.ONSTACK;
    _ = sigaction(sig_segv, &action, &previous_segv);
    _ = sigaction(sig_bus, &action, &previous_bus);
}

fn faultAddress(info: *const std.c.siginfo_t) usize {
    return switch (builtin.os.tag) {
        .linux => @intFromPtr(info.fields.sigfault.addr),
        else => @intFromPtr(info.addr),
    };
}

const SigactionFn = @typeInfo(@FieldType(@FieldType(std.c.Sigaction, "handler"), "sigaction")).optional.child;
const SigArg = @typeInfo(@typeInfo(SigactionFn).pointer.child).@"fn".params[0].type.?;

fn onFault(sig: SigArg, info: *const std.c.siginfo_t, _: ?*anyopaque) callconv(.c) void {
    const number = sigNumber(sig);
    const addr = faultAddress(info);
    if (stack_low != 0 and addr < stack_low + 64 * 1024 and addr +% below_slop >= stack_low) {
        reportOverflow();
    }
    _ = sigaction(number, if (number == sig_bus) &previous_bus else &previous_segv, null);
}

/// jsrt_panic's output, written with write(2) only: stdio is not async-signal-safe, and the
/// overflowed thread may have been inside it.
fn reportOverflow() noreturn {
    var depth: u64 = 0;
    var frame: ?*c.JSRTFrame = c.jsrt_frame_top;
    while (frame) |f| : (frame = f.prev) depth += 1;
    var buf: [128]u8 = undefined;
    const text = std.fmt.bufPrint(&buf, "PANIC: STA2005 stack overflow\nShadow stack depth: {d} frames\n", .{depth}) catch unreachable;
    _ = std.c.write(2, text.ptr, text.len);
    std.c.abort();
}

/// The throw behind JSRT_STACK_CHECK.
export fn jsrt_stack_overflow() c.jsrt_value {
    @branchHint(.cold);
    c.jsrt_throw_error(&c.jsrt_class_range_error, "Maximum call stack size exceeded");
    return c.JSRT_UNDEFINED;
}
