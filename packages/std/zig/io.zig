//! `std/io` backings (docs/STD.md §5): the standard streams and raw file-descriptor I/O through
//! libc's `read`/`write`/`isatty`/`ioctl`. Not Zig's std.Io here: it treats `EBADF` as a
//! programmer bug and would panic, where a bad descriptor is the caller's input and answers
//! `EBADF` (docs/STD.md §3).

const std = @import("std");
const root = @import("jsrt_std.zig");

extern "c" fn fflush(stream: ?*anyopaque) c_int;
extern "c" fn ioctl(fd: c_int, request: c_ulong, ...) c_int;

/// A descriptor argument: an integer in `0..2^31-1`, the range Node's `isatty` accepts. Anything
/// else names no open file. `std/fs`'s descriptor calls take the same range.
pub fn fdArg(fd: f64) ?c_int {
    return root.intIn(fd, 0, std.math.maxInt(c_int));
}

/// A file offset argument (`std/fs` positional I/O): `-1` is the descriptor's own position
/// (null here), any other value an integer in `0..2^53`; anything else is EINVAL.
pub const Offset = union(enum) { current, at: i64, invalid };

pub fn offsetArg(position: f64) Offset {
    if (position == -1) return .current;
    if (!(position >= 0 and position <= 9007199254740992) or @floor(position) != position) return .invalid;
    return .{ .at = @intFromFloat(position) };
}

/// One `read(2)`/`write(2)` (or `pread`/`pwrite` at an offset), retried while it is interrupted
/// (`EINTR`): the byte count, or the errno that ended it.
const Transfer = struct { count: usize = 0, err: std.c.E = .SUCCESS };

fn transfer(comptime op: anytype, args: anytype) Transfer {
    while (true) {
        const n = @call(.auto, op, args);
        if (n >= 0) return .{ .count = @intCast(n) };
        const err = std.c.errno(n);
        if (err != .INTR) return .{ .err = err };
    }
}

/// Writes all of `data` at `at` (or the descriptor's position when null), retrying `EINTR` and
/// short writes; an empty write still makes the call, so a bad descriptor is `EBADF` either way.
/// C stdio is flushed first: `console.log` buffers in `stdout`, and a write that overtook that
/// buffer would reorder the program's own output.
pub fn writeAll(fd: c_int, data: []const u8, at: ?i64) f64 {
    _ = fflush(null);
    var rest = data;
    var offset = at;
    while (true) {
        const step = if (offset) |o| transfer(std.c.pwrite, .{ fd, rest.ptr, rest.len, o }) else transfer(std.c.write, .{ fd, rest.ptr, rest.len });
        if (step.err != .SUCCESS) return root.failErrno(step.err);
        rest = rest[step.count..];
        if (offset) |o| offset = o + @as(i64, @intCast(step.count));
        if (rest.len == 0) return 0;
    }
}

/// `text` as UTF-8 (the C-string boundary: a NUL ends it, docs/FFI.md §3).
export fn jsrt_std_io_write(fd: f64, text: [*:0]const u8) f64 {
    const f = fdArg(fd) orelse return root.fail("EBADF");
    return writeAll(f, std.mem.span(text), null);
}

/// The bytes of the caller's `Uint8Array`, in place (docs/FFI.md §2): the view's storage for the
/// call, never copied. `data` is never NULL, even for an empty view (docs/VALUE.md §4.19).
export fn jsrt_std_io_write_bytes(fd: f64, data: [*]const u8, len: usize) f64 {
    const f = fdArg(fd) orelse return root.fail("EBADF");
    return writeAll(f, data[0..len], null);
}

/// A failure for a backing whose success answer is a count: -1, with the code recorded.
pub fn failCount(status: f64) f64 {
    _ = status;
    return -1;
}

/// One `read(2)` (or `pread` at `at`) of at most `max` bytes straight into the caller's
/// `Uint8Array` (the surface sizes it, docs/STD.md §5): the byte count, zero at end of file, or
/// -1 with the code recorded. `max` outside `0..2^31-1` is EINVAL.
pub fn readOnce(fd: c_int, max: f64, buf: []u8, at: ?i64) f64 {
    const want = root.intIn(max, 0, std.math.maxInt(c_int)) orelse return failCount(root.fail("EINVAL"));
    const into = buf[0..@min(@as(usize, @intCast(want)), buf.len)];
    const step = if (at) |o| transfer(std.c.pread, .{ fd, into.ptr, into.len, o }) else transfer(std.c.read, .{ fd, into.ptr, into.len });
    if (step.err != .SUCCESS) return failCount(root.failErrno(step.err));
    return @floatFromInt(step.count);
}

export fn jsrt_std_io_read(fd: f64, max: f64, buf: [*]u8, len: usize) f64 {
    const f = fdArg(fd) orelse return failCount(root.fail("EBADF"));
    return readOnce(f, max, buf[0..len], null);
}

/// Node's `tty.isatty`: false for a descriptor outside `0..2^31-1` or one that is not a terminal,
/// never an error.
export fn jsrt_std_io_isatty(fd: f64) f64 {
    const f = fdArg(fd) orelse return 0;
    return if (std.c.isatty(f) == 1) 1 else 0;
}

threadlocal var size_columns: f64 = 0;
threadlocal var size_rows: f64 = 0;

/// The terminal's size (`TIOCGWINSZ`), parked for the two readers below. A descriptor that is
/// not a terminal is `ENOTTY`, one that names no open file `EBADF`.
export fn jsrt_std_io_terminal_size(fd: f64) f64 {
    const f = fdArg(fd) orelse return root.fail("EBADF");
    var ws: std.posix.winsize = undefined;
    const rc = ioctl(f, @intCast(std.c.T.IOCGWINSZ), &ws);
    // Darwin refuses a pipe with an errno other than ENOTTY (the std_io golden caught it), so
    // every refusal except a closed descriptor reads as "not a terminal", as `tty.isatty` says.
    if (rc != 0) return root.fail(if (std.c.errno(rc) == .BADF) "EBADF" else "ENOTTY");
    size_columns = @floatFromInt(ws.col);
    size_rows = @floatFromInt(ws.row);
    return 0;
}

export fn jsrt_std_io_terminal_columns() f64 {
    return size_columns;
}

export fn jsrt_std_io_terminal_rows() f64 {
    return size_rows;
}
