//! The `std/` import edge: the one place that knows which `std/*` modules exist. The list is read
//! from the package, so a module landing there needs no change here.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const fspath = std.fs.path;
const project = @import("stator_ts").project;
const support = @import("../support/root.zig");

fn oom() noreturn {
    @panic("out of memory");
}

const prefix = "std/";

pub const Package = struct {
    root: []const u8,
    /// As the checker spells file names: real, because module resolution answers with real paths.
    source_dir: []const u8,
    /// Sorted, without `.ts`.
    modules: []const []const u8,

    pub fn pathMapping(p: Package, a: Allocator) project.PathMapping {
        const target = std.fmt.allocPrint(a, "{s}/*.ts", .{p.source_dir}) catch oom();
        return .{ .pattern = prefix ++ "*", .targets = a.dupe([]const u8, &.{target}) catch oom() };
    }

    pub fn isSourceFile(p: Package, name: []const u8) bool {
        return support.package_root.isInside(p.source_dir, name);
    }

    fn knows(p: Package, name: []const u8) bool {
        return support.names.contains(p.modules, name);
    }

    /// Null for a specifier outside `std/`.
    pub fn classify(p: Package, a: Allocator, specifier: []const u8) ?Specifier {
        if (!std.mem.startsWith(u8, specifier, prefix)) return null;
        if (p.knows(specifier[prefix.len..])) return .module;
        var known: std.ArrayList(u8) = .empty;
        for (p.modules, 0..) |m, i| {
            if (i != 0) known.appendSlice(a, ", ") catch oom();
            known.print(a, prefix ++ "{s}", .{m}) catch oom();
        }
        const list: []const u8 = if (known.items.len == 0) "(none found)" else known.items;
        return .{ .unknown = std.fmt.allocPrint(a, "unknown std module '{s}' — the std modules are {s}", .{ specifier, list }) catch oom() };
    }
};

pub const Specifier = union(enum) {
    module,
    /// STA3002.
    unknown: []const u8,
};

fn isModuleFile(name: []const u8) bool {
    if (!std.mem.endsWith(u8, name, ".ts") or name.len == ".ts".len) return false;
    for (name[0 .. name.len - ".ts".len]) |b| if (b < 'a' or b > 'z') return false;
    return true;
}

/// An unreadable directory is no modules: the first `std/*` import then reports what is missing.
pub fn open(a: Allocator, io: Io, override: ?[]const u8, home: []const u8) Package {
    const root = support.package_root.packageRoot(a, io, override, home, "std", "src") catch oom();
    const source_dir = support.package_root.checkerDir(a, io, fspath.join(a, &.{ root, "src" }) catch oom());
    var names: std.ArrayList([]const u8) = .empty;
    if (Io.Dir.cwd().openDir(io, source_dir, .{ .iterate = true })) |opened| {
        var dir = opened;
        defer dir.close(io);
        var it = dir.iterate();
        while (it.next(io) catch null) |entry| {
            if (!isModuleFile(entry.name)) continue;
            names.append(a, a.dupe(u8, entry.name[0 .. entry.name.len - ".ts".len]) catch oom()) catch oom();
        }
    } else |_| {}
    std.mem.sort([]const u8, names.items, {}, support.names.lessThan);
    return .{ .root = root, .source_dir = source_dir, .modules = names.items };
}

test "a module file is lowercase letters and .ts" {
    try std.testing.expect(isModuleFile("fs.ts"));
    try std.testing.expect(!isModuleFile("fs2.ts"));
    try std.testing.expect(!isModuleFile(".ts"));
    try std.testing.expect(!isModuleFile("fs.d.ts"));
}
