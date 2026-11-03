//! Declarations that take effect before the statement that spells them.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Scope = c.Scope;
const Statement = c.Statement;
const StmtList = c.StmtList;
const E = c.E;
const N = c.N;
const gt = c.gt;
const expressions = @import("expressions.zig");
const statements_mod = @import("statements.zig");
const boundary = @import("boundary.zig");
const module_names = @import("module_names.zig");

pub fn hoistFunctionDeclarations(l: *Lower, statements: []const *Node, b: *Scope) void {
    for (statements) |statement| {
        if (statement.data != .func or statement.data.func.kind != .decl) continue;
        const name = module_names.declaredBindingName(statement) orelse continue;
        l.setHirName(statement, b.declare(name, expressions.typeAt(l, statement, b)));
    }
}

const VarWalk = struct {
    l: *Lower,
    root: *Node,
    is_file: bool,
    b: *Scope,
    seen: c.NameSet = .empty,
    hoisted: StmtList = .empty,

    fn declaration(w: *VarWalk, decl: *Node) void {
        const l = w.l;
        const name_node = decl.data.var_decl.name;
        if (name_node.data != .identifier) {
            l.note(decl, "STA4032", .internal, "var binding is not an identifier");
            return;
        }
        const name = name_node.data.identifier;
        const owned_here = w.is_file or w.b.declaredInUnit(name);
        const known = w.seen.contains(name) or (w.b.has(name) and owned_here);
        w.seen.put(l.a, name, {}) catch c.oom();
        if (known) return;
        const t = expressions.typeAt(l, name_node, w.b);
        var hir = name;
        if (w.is_file or w.b.has(name)) {
            hir = w.b.declare(name, t);
            if (l.g.symbolAt(name_node)) |symbol| for (symbol.decls) |d| l.setHirName(d, hir);
        } else w.b.set(name, t);
        const span = l.span(decl);
        l.push(&w.hoisted, l.st(.declaration, .{ .type = t, .span = span, .name = hir, .decl_kind = .let, .value = l.undef(span) }));
    }

    fn visit(w: *VarWalk, node: *Node) void {
        if (node != w.root and c.isFunctionLike(node)) return;
        if (node.data == .var_list and c.gate.isVarDeclarationList(node)) {
            for (node.data.var_list.decls) |decl| {
                if (statements_mod.classFormation(w.l, decl) == null) w.declaration(decl);
            }
        }
        c.ast.forEachChild(node, w, visit);
    }
};

pub fn hoistVarDeclarations(l: *Lower, root: *Node, is_file: bool, b: *Scope) []const Statement {
    var walk: VarWalk = .{ .l = l, .root = root, .is_file = is_file, .b = b };
    walk.visit(root);
    return walk.hoisted.items;
}

pub fn lowerVarList(l: *Lower, list: *Node, at: *Node, b: *Scope) E!Statement {
    const span = l.span(at);
    var parts: StmtList = .empty;
    for (list.data.var_list.decls) |decl| {
        const v = decl.data.var_decl;
        if (v.name.data != .identifier) return l.internal(decl, "STA4032", "var binding is not an identifier");
        const name = v.name.data.identifier;
        if (!b.has(name)) return l.internal(decl, "STA4032", l.fmt("var '{s}' was not hoisted", .{name}));
        const init = v.init orelse continue;
        const named = statements_mod.withDisplayName(l, try expressions.lowerExpression(l, init, b), name);
        const value = if (b.get(name)) |expected| boundary.maybeBoundary(l, named, expected, init, false) else named;
        l.push(&parts, l.st(.assignment, .{ .type = value.getType(), .span = l.span(decl), .target = b.hirName(name), .value = value }));
    }
    if (parts.items.len == 1) return parts.items[0];
    return l.st(.block, .{ .type = c.H_UNDEFINED, .span = span, .statements = parts.items });
}
