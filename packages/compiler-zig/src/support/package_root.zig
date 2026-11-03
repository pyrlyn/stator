//! Where a first-party sibling package lives: the C runtime, `std` and `node`. One rule for all
//! three, so they cannot disagree about a layout.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;

pub fn exists(io: Io, path: []const u8) bool {
    Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

/// Whether `path` names something below `dir`, which is spelled without a trailing `/`.
pub fn isInside(dir: []const u8, path: []const u8) bool {
    return path.len > dir.len and path[dir.len] == '/' and std.mem.startsWith(u8, path, dir);
}

/// `override` is the environment's value, `home` the compiler's own package directory. A wrong
/// guess fails where the package is first used, never here.
pub fn packageRoot(a: Allocator, io: Io, override: ?[]const u8, home: []const u8, name: []const u8, marker: []const u8) Allocator.Error![]const u8 {
    if (override) |o| if (o.len > 0) return o;
    const sibling = try std.fs.path.join(a, &.{ home, "..", name });
    const probe = try std.fs.path.join(a, &.{ sibling, marker });
    if (exists(io, probe)) return sibling;
    return std.fs.path.join(a, &.{ home, name });
}

/// A source directory as the checker spells file names: the real path, because module resolution
/// answers with real paths and a prefix test has to compare like with like (macOS `/tmp`).
pub fn checkerDir(a: Allocator, io: Io, dir: []const u8) []const u8 {
    return Io.Dir.cwd().realPathFileAlloc(io, dir, a) catch dir;
}

test "an override wins over the layout" {
    const r = try packageRoot(std.testing.allocator, std.testing.io, "/x", "/nowhere", "std", "src");
    try std.testing.expectEqualStrings("/x", r);
}
