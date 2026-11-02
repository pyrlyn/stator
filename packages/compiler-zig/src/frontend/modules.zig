//! What a module's names are. The questions the gate asks live in `gate_modules.zig`; this is the
//! one early error the frontend owes the program itself.
const std = @import("std");
const Allocator = std.mem.Allocator;
const ast = @import("stator_ts").ast;

fn oom() noreturn {
    @panic("out of memory");
}

fn isStrictReserved(name: []const u8) bool {
    return std.mem.eql(u8, name, "eval") or std.mem.eql(u8, name, "arguments");
}

/// The names a module's imports bind at run time, in source order: a type-only import binds none.
pub fn valueImportNames(a: Allocator, root: *ast.Node) []const *ast.Node {
    var names: std.ArrayList(*ast.Node) = .empty;
    for (root.data.source_file.stmts) |statement| {
        if (statement.data != .import_decl) continue;
        const clause_node = statement.data.import_decl.clause orelse continue;
        const clause = clause_node.data.import_clause;
        if (clause.type_only) continue;
        if (clause.name) |name| names.append(a, name) catch oom();
        const bindings = clause.bindings orelse continue;
        switch (bindings.data) {
            .namespace_import => |x| names.append(a, x.name) catch oom(),
            .named_imports => |x| for (x.elems) |element| {
                const spec = element.data.import_spec;
                if (!spec.type_only) names.append(a, spec.name) catch oom();
            },
            else => {},
        }
    }
    return names.items;
}

/// Imported names that a module, being strict code, may not bind: `eval` and `arguments`.
pub fn strictReservedImports(a: Allocator, root: *ast.Node) []const *ast.Node {
    var found: std.ArrayList(*ast.Node) = .empty;
    for (valueImportNames(a, root)) |n| {
        if (n.data == .identifier and isStrictReserved(n.data.identifier)) found.append(a, n) catch oom();
    }
    return found.items;
}
