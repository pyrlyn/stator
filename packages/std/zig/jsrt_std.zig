//! The Zig backings of Stator's `std/*` modules (plan.md §11c T11.2, docs/STD.md §6). The
//! justfile builds this root into one object and archives it as `libjsrt_std.a`; the compiler
//! links that archive only into programs whose module graph holds a `std` file. Every symbol
//! exported here is a C-ABI function named `jsrt_std_*` that a `src/native/*.d.ts` declaration
//! file binds through the extern surface (docs/FFI.md), so the ABI is the FFI table's: `f64` for
//! `number`, NUL-terminated UTF-8 for `CString`, and a `[*]u8` + `usize` pair for a `Uint8Array`
//! (the view's own bytes, valid for the call), nothing else.
//!
//! Shared channels carry what one scalar return cannot:
//! - a failing call returns 1 and records a stable error code (docs/STD.md §3), which the TS
//!   wrapper reads back through `jsrt_std_last_error` and throws;
//! - a string answer is parked in one result buffer and read back through `jsrt_std_result`;
//!   bytes travel in the caller's `Uint8Array`, which the backing reads or fills in place.
//!   The emitter copies a `CString` return into a runtime string at the call site
//!   (docs/FFI.md §3), so the buffer only has to outlive that copy: the next call that parks a
//!   result frees the previous one. Mailboxes and the I/O backend are thread-local;
//!   docs/THREADS.md states which process-wide operations belong on main.
//!
//! This archive depends on libc and nothing else — not on libjsrt.a — so it links in any
//! position on the line.

const std = @import("std");

/// Zig's own I/O implementation behind every file-system and clock call: cross-platform where
/// Zig's std is (§0.5); each caller thread has an independent synchronous backend.
threadlocal var local_io: std.Io.Threaded = .init_single_threaded;
pub fn io() std.Io {
    return local_io.io();
}

/// A safety-check failure (bounds, overflow) in a std backing is a bug in this library, never a
/// user error: say so on stderr and abort, the way a runtime panic ends the process.
pub const panic = std.debug.FullPanic(onPanic);

fn onPanic(msg: []const u8, _: ?usize) noreturn {
    @branchHint(.cold);
    const prefix = "stator std: internal error: ";
    _ = std.c.write(2, prefix, prefix.len);
    _ = std.c.write(2, msg.ptr, msg.len);
    _ = std.c.write(2, "\n", 1);
    std.c.abort();
}

pub const allocator = std.heap.c_allocator;

threadlocal var result: ?[:0]u8 = null;

/// Parks `owned` (allocated with `allocator`) as the answer `jsrt_std_result` returns, freeing
/// the previous answer: its only reader, the emitter's copy, has already run.
pub fn setResult(owned: [:0]u8) void {
    if (result) |old| allocator.free(old);
    result = owned;
}

export fn jsrt_std_result() [*:0]const u8 {
    return if (result) |r| r.ptr else "";
}

threadlocal var last_error: [:0]const u8 = "";

/// Records `code` for `jsrt_std_last_error` and answers the failure status every backing returns.
pub fn fail(code: [:0]const u8) f64 {
    last_error = code;
    return 1;
}

/// The code of a Zig I/O error, from the closed vocabulary docs/STD.md §3 lists. The names are
/// POSIX's errno names because those are the stable, documented spelling of each condition; an
/// error outside the table is `EIO`, never a guess at a closer one.
pub fn failWith(err: anyerror) f64 {
    return fail(switch (err) {
        error.FileNotFound => "ENOENT",
        error.AccessDenied, error.PermissionDenied => "EACCES",
        error.PathAlreadyExists => "EEXIST",
        error.NotDir => "ENOTDIR",
        error.IsDir => "EISDIR",
        error.DirNotEmpty => "ENOTEMPTY",
        error.NameTooLong => "ENAMETOOLONG",
        error.SymLinkLoop => "ELOOP",
        error.NoSpaceLeft => "ENOSPC",
        error.ReadOnlyFileSystem => "EROFS",
        error.FileBusy, error.DeviceBusy => "EBUSY",
        error.OutOfMemory, error.SystemResources => "ENOMEM",
        error.BadPathName => "EINVAL",
        error.FileTooBig, error.StreamTooLong => "EFBIG",
        else => "EIO",
    });
}

/// The status a backing returns for a call that answers nothing but success or failure.
pub fn status(outcome: anyerror!void) f64 {
    outcome catch |err| return failWith(err);
    return 0;
}

export fn jsrt_std_last_error() [*:0]const u8 {
    return last_error.ptr;
}

/// The code of a libc errno, for the backings that call libc directly (fd I/O, where Zig's std
/// treats `EBADF` as a programmer bug and would panic instead of answering). Same closed
/// vocabulary as `failWith`; `EINTR` never reaches here, the callers retry it.
pub fn failErrno(err: std.c.E) f64 {
    return fail(switch (err) {
        .NOENT => "ENOENT",
        .ACCES, .PERM => "EACCES",
        .EXIST => "EEXIST",
        .NOTDIR => "ENOTDIR",
        .NOTEMPTY => "ENOTEMPTY",
        .NAMETOOLONG => "ENAMETOOLONG",
        .LOOP => "ELOOP",
        .ROFS => "EROFS",
        .BUSY, .TXTBSY => "EBUSY",
        .BADF => "EBADF",
        .NOTTY => "ENOTTY",
        .AGAIN => "EAGAIN",
        .PIPE => "EPIPE",
        .ISDIR => "EISDIR",
        .NOSPC => "ENOSPC",
        .NOMEM => "ENOMEM",
        .INVAL => "EINVAL",
        .FBIG => "EFBIG",
        else => "EIO",
    });
}

/// A JS number as a C `int` argument, or null when it is not an integer in `[lo, hi]`.
pub fn intIn(value: f64, lo: c_int, hi: c_int) ?c_int {
    if (!(value >= @as(f64, @floatFromInt(lo)) and value <= @as(f64, @floatFromInt(hi)))) return null;
    if (@trunc(value) != value) return null;
    return @intFromFloat(value);
}

comptime {
    _ = @import("env.zig");
    _ = @import("process.zig");
    _ = @import("fs.zig");
    _ = @import("time.zig");
    _ = @import("os.zig");
    _ = @import("io.zig");
    _ = @import("encoding.zig");
    _ = @import("hash.zig");
}

/// Worker-local native mailboxes do not outlive the synchronous callback that uses them.
export fn jsrt_std_thread_cleanup() void {
    if (result) |owned| allocator.free(owned);
    result = null;
    @import("fs.zig").cleanup();
}
