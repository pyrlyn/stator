//! Everything `build` writes (`src/cli/outputs.ts`): an output that would overwrite an input or
//! another output is STA0004, and a path the user cannot write is the user's to fix (STA0019),
//! never a compiler bug.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const fspath = std.fs.path;
const failure = @import("failure.zig");
const Reporter = failure.Reporter;
const Error = failure.Error;
const oom = failure.oom;

pub const Named = struct { role: []const u8, path: []const u8 };

/// Names an existing file, whichever link reached it.
pub fn statKey(a: Allocator, io: Io, absolute: []const u8) ?[]const u8 {
    const st = Io.Dir.cwd().statFile(io, absolute, .{}) catch return null;
    // `Stat` has no device number; size and mtime keep two volumes' equal inodes apart.
    return std.fmt.allocPrint(a, "inode:{d}:{d}:{d}", .{ st.inode, st.size, st.mtime.toNanoseconds() }) catch oom();
}

var case_probe_seq: u32 = 0;

fn directoryFoldsCase(a: Allocator, io: Io, dir: []const u8) bool {
    case_probe_seq += 1;
    const probe_name = std.fmt.allocPrint(a, ".stator-case-{x}-{d}", .{ @intFromPtr(dir.ptr), case_probe_seq }) catch oom();
    const other_name = a.dupe(u8, probe_name) catch oom();
    for (other_name) |*c| c.* = if (c.* >= 'a' and c.* <= 'z') c.* - ('a' - 'A') else c.*;
    if (std.mem.eql(u8, probe_name, other_name)) return false;
    const probe = fspath.join(a, &.{ dir, probe_name }) catch oom();
    const other = fspath.join(a, &.{ dir, other_name }) catch oom();
    Io.Dir.cwd().writeFile(io, .{ .sub_path = probe, .data = "" }) catch return false;
    defer Io.Dir.cwd().deleteFile(io, probe) catch {};
    const a_st = Io.Dir.cwd().statFile(io, probe, .{}) catch return false;
    const b_st = Io.Dir.cwd().statFile(io, other, .{}) catch return false;
    return a_st.inode == b_st.inode;
}

fn fileKey(a: Allocator, io: Io, path: []const u8) []const u8 {
    const absolute = absolutePath(a, io, path);
    if (statKey(a, io, absolute)) |key| return key;
    const dir = fspath.dirname(absolute) orelse "/";
    const real = Io.Dir.cwd().realPathFileAlloc(io, dir, a) catch return std.fmt.allocPrint(a, "path:{s}", .{absolute}) catch oom();
    const name = fspath.basename(absolute);
    if (directoryFoldsCase(a, io, real)) {
        const lower = a.alloc(u8, name.len) catch oom();
        _ = std.ascii.lowerString(lower, name);
        return std.fmt.allocPrint(a, "path:{s}/{s}", .{ real, lower }) catch oom();
    }
    return std.fmt.allocPrint(a, "path:{s}/{s}", .{ real, name }) catch oom();
}

pub fn absolutePath(a: Allocator, io: Io, path: []const u8) []const u8 {
    const cwd = std.process.currentPathAlloc(io, a) catch oom();
    return fspath.resolve(a, &.{ cwd, path }) catch oom();
}

/// Runs before anything is written, so a refused build leaves every file as it was.
pub fn refuseAliased(a: Allocator, io: Io, r: *Reporter, outputs: []const Named, inputs: []const Named) Error!void {
    var seen: std.StringHashMapUnmanaged(Named) = .empty;
    for (outputs) |output| {
        const key = fileKey(a, io, output.path);
        if (seen.get(key)) |earlier|
            return r.fail("STA0004", "{s} \"{s}\" and {s} \"{s}\" name the same file — one output would overwrite the other", .{ earlier.role, earlier.path, output.role, output.path });
        seen.put(a, key, output) catch oom();
    }
    for (inputs) |input| {
        if (seen.get(fileKey(a, io, input.path))) |output|
            return r.fail("STA0004", "{s} \"{s}\" is {s} \"{s}\" — refusing to overwrite an input", .{ output.role, output.path, input.role, input.path });
    }
}

const WriteFailure = struct { code: []const u8, why: []const u8 };

fn describe(err: anyerror) ?WriteFailure {
    return switch (err) {
        error.FileNotFound => .{ .code = "ENOENT", .why = "the directory does not exist" },
        error.NotDir => .{ .code = "ENOTDIR", .why = "a parent of it is not a directory" },
        error.IsDir => .{ .code = "EISDIR", .why = "it is a directory" },
        error.AccessDenied => .{ .code = "EACCES", .why = "permission denied" },
        error.PermissionDenied => .{ .code = "EPERM", .why = "operation not permitted" },
        error.ReadOnlyFileSystem => .{ .code = "EROFS", .why = "the file system is read-only" },
        error.NoSpaceLeft => .{ .code = "ENOSPC", .why = "no space left on the device" },
        else => null,
    };
}

fn writeError(r: *Reporter, target: Named, err: anyerror) Error {
    if (describe(err)) |d|
        return r.fail("STA0019", "cannot write {s} \"{s}\": {s} ({s})", .{ target.role, target.path, d.code, d.why });
    return r.fail("STA4072", "internal error: {t} writing {s} — this is a compiler bug; report it with the input that triggered it", .{ err, target.path });
}

/// Before a tool writes `target`: without this, clang's own failure there would read as a compiler
/// bug (STA0009). A file already there must be writable too: ld64 opens it in place.
pub fn requireWritable(a: Allocator, io: Io, r: *Reporter, target: Named) Error!void {
    if (Io.Dir.cwd().statFile(io, target.path, .{})) |st| {
        if (st.kind == .directory) return writeError(r, target, error.IsDir);
        Io.Dir.cwd().access(io, target.path, .{ .write = true }) catch |e| return writeError(r, target, e);
    } else |e| switch (e) {
        error.FileNotFound => {},
        else => {},
    }
    const dir = fspath.dirname(absolutePath(a, io, target.path)) orelse "/";
    Io.Dir.cwd().access(io, dir, .{ .write = true }) catch |e| return writeError(r, target, e);
}

pub fn write(io: Io, r: *Reporter, target: Named, content: []const u8) Error!void {
    Io.Dir.cwd().writeFile(io, .{ .sub_path = target.path, .data = content }) catch |e| return writeError(r, target, e);
}

test "two spellings of one new file are one output" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var r: Reporter = .{ .a = a };
    try std.testing.expectError(error.Failed, refuseAliased(a, std.testing.io, &r, &.{
        .{ .role = "-o", .path = "/nonexistent-dir/x" },
        .{ .role = "--emit-header", .path = "/nonexistent-dir/./x" },
    }, &.{}));
    try std.testing.expectEqualStrings("STA0004", r.failure.?.code);
}

test "case-only aliases of a new output are one file on a folding directory" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const rel = std.fmt.allocPrint(a, ".zig-cache/tmp/{s}", .{&tmp.sub_path}) catch oom();
    const dir = Io.Dir.cwd().realPathFileAlloc(io, rel, a) catch return error.SkipZigTest;
    if (!directoryFoldsCase(a, io, dir)) return error.SkipZigTest;
    const upper = fspath.join(a, &.{ dir, "OUT.o" }) catch oom();
    const lower = fspath.join(a, &.{ dir, "out.o" }) catch oom();
    var r: Reporter = .{ .a = a };
    try std.testing.expectError(error.Failed, refuseAliased(a, io, &r, &.{
        .{ .role = "-o", .path = upper },
        .{ .role = "--emit-header", .path = lower },
    }, &.{}));
    try std.testing.expectEqualStrings("STA0004", r.failure.?.code);
}

test "a directory that does not exist is the user's to fix" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var r: Reporter = .{ .a = arena.allocator() };
    try std.testing.expectError(error.Failed, requireWritable(arena.allocator(), std.testing.io, &r, .{ .role = "-o", .path = "/nonexistent-dir/x" }));
    try std.testing.expectEqualStrings("cannot write -o \"/nonexistent-dir/x\": ENOENT (the directory does not exist)", r.failure.?.message);
}
