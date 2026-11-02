//! The Node platform edge (docs/MODES.md §6): which specifiers name a Node built-in, and whether
//! `packages/node` has landed them. Resolution itself is the path mapping, so a mapped file loads
//! like any other; everything here answers for the modules that have no file yet.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const fspath = std.fs.path;
const project = @import("stator_ts").project;
const support = @import("../support/root.zig");
const members = @import("node_members.zig");

fn oom() noreturn {
    @panic("out of memory");
}

const prefix = "node:";
const t11_6 = "planned for Phase 11 (T11.6: packages/node)";

pub const NotYet = struct {
    message: []const u8,
    phase: ?u32 = null,
};

/// `node:*` and the bare spellings from the pinned Node's `builtinModules`.
pub fn builtinId(specifier: []const u8) ?[]const u8 {
    if (std.mem.startsWith(u8, specifier, prefix)) {
        const id = specifier[prefix.len..];
        return if (members.isBuiltinId(id)) id else null;
    }
    return if (members.isBareId(specifier)) specifier else null;
}

pub const Package = struct {
    a: Allocator,
    io: Io,
    /// As the checker spells file names.
    source_dir: []const u8,

    pub fn globalsFile(p: Package) ?[]const u8 {
        const file = std.fmt.allocPrint(p.a, "{s}/globals.d.ts", .{p.source_dir}) catch oom();
        Io.Dir.cwd().access(p.io, file, .{}) catch return null;
        return file;
    }

    pub fn locationModule(p: Package) []const u8 {
        return std.fmt.allocPrint(p.a, "{s}/internal/location", .{p.source_dir}) catch oom();
    }

    pub fn locationFile(p: Package) []const u8 {
        return std.fmt.allocPrint(p.a, "{s}/internal/location.ts", .{p.source_dir}) catch oom();
    }

    pub fn pathMappings(p: Package, a: Allocator) []const project.PathMapping {
        var out: std.ArrayList(project.PathMapping) = .empty;
        const star = std.fmt.allocPrint(a, "{s}/*.ts", .{p.source_dir}) catch oom();
        out.append(a, .{ .pattern = prefix ++ "*", .targets = a.dupe([]const u8, &.{star}) catch oom() }) catch oom();
        for (members.bare_ids) |id| {
            const target = std.fmt.allocPrint(a, "{s}/{s}.ts", .{ p.source_dir, id }) catch oom();
            out.append(a, .{ .pattern = id, .targets = a.dupe([]const u8, &.{target}) catch oom() }) catch oom();
        }
        return out.items;
    }

    fn landed(p: Package, id: []const u8) bool {
        const file = std.fmt.allocPrint(p.a, "{s}/{s}.ts", .{ p.source_dir, id }) catch oom();
        return support.package_root.exists(p.io, file);
    }

    pub fn isSourceFile(p: Package, name: []const u8) bool {
        return support.package_root.isInside(p.source_dir, name);
    }

    /// Null when a Node built-in is not what stands in the way.
    pub fn classifySpecifier(p: Package, specifier: []const u8, node: bool) ?NotYet {
        const id = builtinId(specifier) orelse return null;
        if (!node) return .{ .message = std.fmt.allocPrint(p.a, "'{s}' is a Node built-in; it is available with --node (docs/MODES.md §6)", .{specifier}) catch oom() };
        if (p.landed(id)) return null;
        return .{ .message = std.fmt.allocPrint(p.a, "'{s}' is not yet supported; " ++ t11_6, .{specifier}) catch oom(), .phase = 11 };
    }

    /// A member Node has and the wrapper does not. Anything Node lacks stays the checker's error.
    pub fn classifyMember(p: Package, specifier: []const u8, member: []const u8, node: bool) ?NotYet {
        const id = builtinId(specifier) orelse return null;
        if (!node or !p.landed(id) or !members.hasMember(id, member)) return null;
        return .{ .message = std.fmt.allocPrint(p.a, "'{s}' from '{s}' is not yet supported; " ++ t11_6, .{ member, specifier }) catch oom(), .phase = 11 };
    }
};

pub fn open(a: Allocator, io: Io, override: ?[]const u8, home: []const u8) Package {
    const root = support.package_root.packageRoot(a, io, override, home, "node", "src") catch oom();
    const source_dir = support.package_root.checkerDir(a, io, fspath.join(a, &.{ root, "src" }) catch oom());
    return .{ .a = a, .io = io, .source_dir = source_dir };
}

test "only public ids are built-ins" {
    try std.testing.expectEqualStrings("fs", builtinId("node:fs").?);
    try std.testing.expectEqualStrings("fs", builtinId("fs").?);
    try std.testing.expectEqualStrings("test", builtinId("node:test").?);
    try std.testing.expect(builtinId("test") == null);
    try std.testing.expect(builtinId("_http_agent") == null);
    try std.testing.expect(builtinId("node:_http_agent") == null);
    try std.testing.expect(builtinId("node:nonsense") == null);
}
