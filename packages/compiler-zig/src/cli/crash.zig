//! The compiler's last words: whatever stops it from inside is one `STA` line and exit status 1,
//! never a stack trace in front of a user. A stack overflow is a signal, and everything a source
//! file nests is what recurses, so the overflow is the user's input reaching this file.
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const terminal = @import("terminal.zig");

const suffix = " — this is a compiler bug; report it with the input that triggered it";
const checker_overflow = "the TypeScript checker ran out of stack type-checking this program (plain `tsc` fails on it too) — return-type annotations on long chains of functions that infer their return types from each other shorten its inference";

/// A signal handler cannot allocate.
var layout_buffer: [1 << 16]u8 = undefined;
var columns: usize = 80;
var colored = false;
var checking: std.atomic.Value(bool) = .init(false);
var stopped: std.atomic.Value(bool) = .init(false);

pub fn configure(width: usize, color: bool) void {
    columns = width;
    colored = color;
}

/// The checker's overflow has its own code, because the user can do something about it.
pub fn setChecking(on: bool) void {
    checking.store(on, .release);
}

fn print(text: []const u8) void {
    if (stopped.swap(true, .acq_rel)) std.process.exit(1);
    var fixed: std.heap.FixedBufferAllocator = .init(&layout_buffer);
    const lines: []const terminal.Line = &.{.{ .text = text, .color = .red }};
    std.debug.print("{s}", .{terminal.render(fixed.allocator(), lines, columns, colored)});
}

fn internalError(message: []const u8) void {
    var buffer: [4096]u8 = undefined;
    const clipped = message[0..@min(message.len, buffer.len - 256)];
    print(std.fmt.bufPrint(&buffer, "stator: STA4072 internal error: {s}" ++ suffix, .{clipped}) catch unreachable);
}

pub fn panic(message: []const u8, first_address: ?usize) noreturn {
    internalError(message);
    // A panic during the port is a bug someone is about to chase; a release build has no reader.
    if (builtin.mode == .debug) std.debug.dumpCurrentStackTrace(.{ .first_address = first_address orelse @returnAddress() });
    std.process.exit(1);
}

fn stackPointer(context: ?*anyopaque) ?usize {
    const native = std.debug.cpu_context.fromPosixSignalContext(context) orelse return null;
    return switch (builtin.cpu.arch) {
        .aarch64 => native.sp,
        .x86_64 => native.gprs.get(.rsp),
        else => null,
    };
}

fn faultAddress(info: *const posix.siginfo_t) usize {
    return @intFromPtr(if (builtin.os.tag == .linux) info.fields.sigfault.addr else info.addr);
}

/// A prologue faults within one frame of the stack pointer; nothing else lands there.
const largest_frame = 1 << 20;

fn isStackOverflow(info: *const posix.siginfo_t, context: ?*anyopaque) bool {
    const sp = stackPointer(context) orelse return false;
    const fault = faultAddress(info);
    return (if (fault > sp) fault - sp else sp - fault) < largest_frame;
}

fn onFault(_: posix.SIG, info: *const posix.siginfo_t, context: ?*anyopaque) callconv(.c) void {
    if (!isStackOverflow(info, context)) {
        internalError("segmentation fault");
    } else if (checking.load(.acquire)) {
        print("stator: STA0013 " ++ checker_overflow);
    } else {
        internalError("Maximum call stack size exceeded");
    }
    std.process.exit(1);
}

pub fn install() void {
    if (builtin.os.tag == .windows) return;
    const action: posix.Sigaction = .{
        .handler = .{ .sigaction = onFault },
        .mask = posix.sigemptyset(),
        .flags = posix.SA.SIGINFO | posix.SA.ONSTACK,
    };
    posix.sigaction(.SEGV, &action, null);
    posix.sigaction(.BUS, &action, null);
}
