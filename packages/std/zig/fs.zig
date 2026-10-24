//! `std/fs` backings (docs/STD.md §5): sync, path-only file-system calls through Zig's std.Io, so
//! the POSIX and (later) Windows answers come from one implementation. Paths are relative to the
//! working directory or absolute, exactly as the OS resolves them; nothing here normalizes.

const std = @import("std");
const root = @import("jsrt_std.zig");
const io = @import("io.zig");

fn cwd() std.Io.Dir {
    return std.Io.Dir.cwd();
}

/// The whole file, NUL-terminated for the `CString` copy. A NUL byte inside the file therefore
/// ends the text early — the C-string boundary's documented truncation (docs/FFI.md §3);
/// `jsrt_std_fs_read_bytes` carries every byte.
export fn jsrt_std_fs_read_text(path: [*:0]const u8) f64 {
    const data = cwd().readFileAllocOptions(root.io(), std.mem.span(path), root.allocator, .unlimited, .of(u8), 0) catch |err| return root.failWith(err);
    root.setResult(data);
    return 0;
}

/// Creates or truncates the file, mode 0666 before the umask.
export fn jsrt_std_fs_write_text(path: [*:0]const u8, text: [*:0]const u8) f64 {
    return root.status(cwd().writeFile(root.io(), .{ .sub_path = std.mem.span(path), .data = std.mem.span(text) }));
}

const Kind = enum(u8) { other = 0, file = 1, directory = 2 };

threadlocal var stat_size: f64 = 0;
threadlocal var stat_kind: Kind = .other;
threadlocal var stat_mtime_ms: f64 = 0;

/// Follows symlinks (`stat`, not `lstat`). The fields are parked for the three readers below,
/// which the TS wrapper calls immediately after a successful call.
export fn jsrt_std_fs_stat(path: [*:0]const u8) f64 {
    const st = cwd().statFile(root.io(), std.mem.span(path), .{}) catch |err| return root.failWith(err);
    stat_size = @floatFromInt(st.size);
    stat_kind = switch (st.kind) {
        .file => .file,
        .directory => .directory,
        else => .other,
    };
    stat_mtime_ms = @floatFromInt(st.mtime.toMilliseconds());
    return 0;
}

export fn jsrt_std_fs_stat_size() f64 {
    return stat_size;
}

export fn jsrt_std_fs_stat_kind() f64 {
    return @floatFromInt(@intFromEnum(stat_kind));
}

export fn jsrt_std_fs_stat_mtime_ms() f64 {
    return stat_mtime_ms;
}

/// One level, mode 0777 before the umask; an existing path is EEXIST.
export fn jsrt_std_fs_mkdir(path: [*:0]const u8) f64 {
    return root.status(cwd().createDir(root.io(), std.mem.span(path), .default_dir));
}

export fn jsrt_std_fs_unlink(path: [*:0]const u8) f64 {
    return root.status(cwd().deleteFile(root.io(), std.mem.span(path)));
}

/// Empty directories only; a non-empty one is ENOTEMPTY.
export fn jsrt_std_fs_rmdir(path: [*:0]const u8) f64 {
    return root.status(cwd().deleteDir(root.io(), std.mem.span(path)));
}

/// The file `jsrt_std_fs_read_bytes` read, until `jsrt_std_fs_read_bytes_take` copies it out.
threadlocal var parked: []u8 = &.{};

/// Reads the whole file and parks it: the byte count, or -1 with the code recorded. The size is
/// known only after the read, so the surface cannot allocate the answer first (docs/STD.md §6).
export fn jsrt_std_fs_read_bytes(path: [*:0]const u8) f64 {
    const data = cwd().readFileAlloc(root.io(), std.mem.span(path), root.allocator, .unlimited) catch |err| return io.failCount(root.failWith(err));
    root.allocator.free(parked);
    parked = data;
    return @floatFromInt(data.len);
}

/// Copies the parked file into the caller's `Uint8Array` and frees it. The surface sizes the
/// view from the count above, so a different length is a bug in `std` (a ReleaseSafe trap).
export fn jsrt_std_fs_read_bytes_take(out: [*]u8, len: usize) f64 {
    @memcpy(out[0..len], parked);
    root.allocator.free(parked);
    parked = &.{};
    return 0;
}

/// Node's `fs.existsSync`: whether the path names anything, symbolic links followed. Every
/// failure, a permission refusal included, answers 0 rather than an error.
export fn jsrt_std_fs_exists(path: [*:0]const u8) f64 {
    cwd().access(root.io(), std.mem.span(path), .{}) catch return 0;
    return 1;
}

/// The canonical absolute path (`realpath(3)`: symbolic links, `.` and `..` resolved), parked in
/// the result slot. The path must exist.
export fn jsrt_std_fs_realpath(path: [*:0]const u8) f64 {
    const resolved = cwd().realPathFileAlloc(root.io(), std.mem.span(path), root.allocator) catch |err| return root.failWith(err);
    root.setResult(resolved);
    return 0;
}

/// A timestamp argument in milliseconds since the Unix epoch, fractions kept to the nanosecond.
/// Outside the range a `Date` can hold (±8.64e15 ms) or not finite is null.
fn msTimespec(ms: f64) ?std.c.timespec {
    if (!(ms >= -8.64e15 and ms <= 8.64e15)) return null;
    const ns: i128 = @intFromFloat(@round(ms * 1e6));
    return .{ .sec = @intCast(@divFloor(ns, std.time.ns_per_s)), .nsec = @intCast(@mod(ns, std.time.ns_per_s)) };
}

/// Sets the access and modification times (symbolic links followed). libc's `utimensat`, not
/// std.Io: Zig 0.16's `setTimestamps` reports a missing path as `Unexpected`, which would read as
/// `EIO` where Node says `ENOENT`.
export fn jsrt_std_fs_utimes(path: [*:0]const u8, atime_ms: f64, mtime_ms: f64) f64 {
    const times = [2]std.c.timespec{
        msTimespec(atime_ms) orelse return root.fail("EINVAL"),
        msTimespec(mtime_ms) orelse return root.fail("EINVAL"),
    };
    while (true) {
        const rc = std.c.utimensat(std.c.AT.FDCWD, path, &times, 0);
        if (rc == 0) return 0;
        const err = std.c.errno(rc);
        if (err != .INTR) return root.failErrno(err);
    }
}

/// The last `readdir`'s names, freed when the next one replaces them.
threadlocal var dir_names: [][:0]u8 = &.{};

fn freeNames() void {
    for (dir_names) |name| root.allocator.free(name);
    root.allocator.free(dir_names);
    dir_names = &.{};
}

fn byteOrder(_: void, a: [:0]u8, b: [:0]u8) bool {
    return std.mem.lessThan(u8, a, b);
}

/// The directory's entry names without `.` and `..`, in byte order: libuv's scandir sorts with
/// `strcmp`, so this is the order Node's `readdirSync` answers. Parked for the two readers below.
export fn jsrt_std_fs_readdir(path: [*:0]const u8) f64 {
    freeNames();
    var dir = cwd().openDir(root.io(), std.mem.span(path), .{ .iterate = true }) catch |err| return root.failWith(err);
    defer dir.close(root.io());
    var names: std.ArrayList([:0]u8) = .empty;
    errdefer {
        for (names.items) |name| root.allocator.free(name);
        names.deinit(root.allocator);
    }
    var it = dir.iterate();
    while (true) {
        const entry = (it.next(root.io()) catch |err| return discard(&names, err)) orelse break;
        const name = root.allocator.dupeZ(u8, entry.name) catch return discard(&names, error.OutOfMemory);
        names.append(root.allocator, name) catch {
            root.allocator.free(name);
            return discard(&names, error.OutOfMemory);
        };
    }
    std.mem.sort([:0]u8, names.items, {}, byteOrder);
    dir_names = names.toOwnedSlice(root.allocator) catch return discard(&names, error.OutOfMemory);
    return 0;
}

fn discard(names: *std.ArrayList([:0]u8), err: anyerror) f64 {
    for (names.items) |name| root.allocator.free(name);
    names.deinit(root.allocator);
    return root.failWith(err);
}

export fn jsrt_std_fs_readdir_count() f64 {
    return @floatFromInt(dir_names.len);
}

/// The caller keeps `index` below `jsrt_std_fs_readdir_count()`.
export fn jsrt_std_fs_readdir_name(index: f64) [*:0]const u8 {
    const i = root.intIn(index, 0, std.math.maxInt(c_int)) orelse return "";
    if (@as(usize, @intCast(i)) >= dir_names.len) return "";
    return dir_names[@intCast(i)].ptr;
}

/// Node's `open` flag strings (libuv's `stringToFlags`), each to its `open(2)` flags; a string
/// outside this table is EINVAL. Every descriptor is opened close-on-exec, as libuv opens them.
fn openFlags(text: []const u8) ?std.c.O {
    const Row = struct { []const u8, std.c.O };
    const rows = [_]Row{
        .{ "r", .{ .ACCMODE = .RDONLY } },
        .{ "rs", .{ .ACCMODE = .RDONLY, .SYNC = true } },
        .{ "sr", .{ .ACCMODE = .RDONLY, .SYNC = true } },
        .{ "r+", .{ .ACCMODE = .RDWR } },
        .{ "rs+", .{ .ACCMODE = .RDWR, .SYNC = true } },
        .{ "sr+", .{ .ACCMODE = .RDWR, .SYNC = true } },
        .{ "w", .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true } },
        .{ "wx", .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true, .EXCL = true } },
        .{ "xw", .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true, .EXCL = true } },
        .{ "w+", .{ .ACCMODE = .RDWR, .CREAT = true, .TRUNC = true } },
        .{ "wx+", .{ .ACCMODE = .RDWR, .CREAT = true, .TRUNC = true, .EXCL = true } },
        .{ "xw+", .{ .ACCMODE = .RDWR, .CREAT = true, .TRUNC = true, .EXCL = true } },
        .{ "a", .{ .ACCMODE = .WRONLY, .CREAT = true, .APPEND = true } },
        .{ "ax", .{ .ACCMODE = .WRONLY, .CREAT = true, .APPEND = true, .EXCL = true } },
        .{ "xa", .{ .ACCMODE = .WRONLY, .CREAT = true, .APPEND = true, .EXCL = true } },
        .{ "as", .{ .ACCMODE = .WRONLY, .CREAT = true, .APPEND = true, .SYNC = true } },
        .{ "sa", .{ .ACCMODE = .WRONLY, .CREAT = true, .APPEND = true, .SYNC = true } },
        .{ "a+", .{ .ACCMODE = .RDWR, .CREAT = true, .APPEND = true } },
        .{ "ax+", .{ .ACCMODE = .RDWR, .CREAT = true, .APPEND = true, .EXCL = true } },
        .{ "xa+", .{ .ACCMODE = .RDWR, .CREAT = true, .APPEND = true, .EXCL = true } },
        .{ "as+", .{ .ACCMODE = .RDWR, .CREAT = true, .APPEND = true, .SYNC = true } },
        .{ "sa+", .{ .ACCMODE = .RDWR, .CREAT = true, .APPEND = true, .SYNC = true } },
    };
    for (rows) |row| {
        if (std.mem.eql(u8, row[0], text)) {
            var flags = row[1];
            flags.CLOEXEC = true;
            return flags;
        }
    }
    return null;
}

/// Opens `path` and answers the descriptor, which the program owns until `close` (docs/STD.md
/// §9.3); a created file gets mode 0666 before the umask. Not std.Io: its `File` is a handle with
/// its own lifetime, and a descriptor here is a plain integer the caller passes back.
export fn jsrt_std_fs_open(path: [*:0]const u8, flags: [*:0]const u8) f64 {
    const oflags = openFlags(std.mem.span(flags)) orelse return io.failCount(root.fail("EINVAL"));
    while (true) {
        const fd = std.c.open(path, oflags, @as(std.c.mode_t, 0o666));
        if (fd >= 0) return @floatFromInt(fd);
        const err = std.c.errno(fd);
        if (err != .INTR) return io.failCount(root.failErrno(err));
    }
}

/// `close(2)`; a descriptor that names no open file is EBADF. An interrupted close is not
/// retried: POSIX leaves the descriptor's state unspecified, and Linux has already freed it.
export fn jsrt_std_fs_close(fd: f64) f64 {
    const f = io.fdArg(fd) orelse return root.fail("EBADF");
    const rc = std.c.close(f);
    if (rc != 0 and std.c.errno(rc) != .INTR) return root.failErrno(std.c.errno(rc));
    return 0;
}

/// One read of at most `max` bytes at `position` (`-1`: the descriptor's own position, which
/// then advances) straight into the caller's `Uint8Array`: the count, or -1 on failure.
export fn jsrt_std_fs_read(fd: f64, max: f64, position: f64, buf: [*]u8, len: usize) f64 {
    const f = io.fdArg(fd) orelse return io.failCount(root.fail("EBADF"));
    return switch (io.offsetArg(position)) {
        .current => io.readOnce(f, max, buf[0..len], null),
        .at => |at| io.readOnce(f, max, buf[0..len], at),
        .invalid => io.failCount(root.fail("EINVAL")),
    };
}

/// Writes all of the caller's `Uint8Array`, in place, at `position` (`-1`: the descriptor's own
/// position).
export fn jsrt_std_fs_write(fd: f64, position: f64, data: [*]const u8, len: usize) f64 {
    const f = io.fdArg(fd) orelse return root.fail("EBADF");
    return switch (io.offsetArg(position)) {
        .current => io.writeAll(f, data[0..len], null),
        .at => |at| io.writeAll(f, data[0..len], at),
        .invalid => root.fail("EINVAL"),
    };
}

pub fn cleanup() void {
    root.allocator.free(parked);
    parked = &.{};
    freeNames();
}
