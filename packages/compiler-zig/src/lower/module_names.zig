//! What a module binds and where an import lands. Port of the compiler's `frontend/modules.ts`.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Symbol = c.Symbol;
const File = c.File;
const F = c.F;
const gt = c.gt;
const api = c.api;

pub const DEFAULT_EXPORT_BINDING = "*default*";

pub const ExportTarget = union(enum) {
    binding: struct { file: *File, name: []const u8 },
    namespace: *File,
};

pub fn declaredBindingName(node: *const Node) ?[]const u8 {
    const name = switch (node.data) {
        .func => |f| f.name,
        .class => |x| x.name,
        else => unreachable,
    };
    if (name) |n| return api.text(n);
    return if (gt.isDefaultExportDeclaration(node)) DEFAULT_EXPORT_BINDING else null;
}

fn declarationTarget(l: *Lower, symbol: *Symbol) ?ExportTarget {
    const declaration = l.g.declarationOf(symbol) orelse (if (symbol.decls.len > 0) symbol.decls[0] else return null);
    if (declaration.data == .source_file) return .{ .namespace = l.fileOfNode(declaration) };
    const file = l.fileOfNode(declaration);
    if (file.is_dts or symbol.flags & F.value == 0) return null;
    if (declaration.data == .func and declaration.data.func.kind == .decl or declaration.data == .class and !declaration.data.class.is_expr) {
        return .{ .binding = .{ .file = file, .name = declaredBindingName(declaration) orelse return null } };
    }
    const name = api.declarationName(declaration) orelse return null;
    if (name.data != .identifier) return null;
    return .{ .binding = .{ .file = file, .name = name.data.identifier } };
}

pub fn exportTarget(l: *Lower, symbol: ?*Symbol) ?ExportTarget {
    var seen: std.AutoHashMapUnmanaged(*Symbol, void) = .empty;
    var current = symbol;
    while (current) |s| {
        if (seen.contains(s)) return null;
        seen.put(l.a, s, {}) catch c.oom();
        for (s.decls) |d| {
            if (d.data != .export_assign) continue;
            if (d.data.export_assign.is_equals) return null;
            return .{ .binding = .{ .file = l.fileOfNode(d), .name = DEFAULT_EXPORT_BINDING } };
        }
        if (s.flags & F.alias == 0) return declarationTarget(l, s);
        const next = l.session().immediateAliased(.{ .symbol = s }) orelse return null;
        current = next.binderSymbol();
    }
    return null;
}
