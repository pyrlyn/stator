//! Functions and their parts: the generic, generator, await and parameter rules.

const std = @import("std");
const api = @import("gate_api.zig");
const core = @import("gate.zig");
const extern_ = @import("gate_extern.zig");
const generics = @import("gate_generics.zig");
const ast_walk = @import("../support/ast_walk.zig");

const Gate = api.Gate;
const Node = api.Node;
const Result = api.Result;
const accept = api.accept;
const eql = api.eql;

fn hasFunctionImplementation(fn_: *Node) bool {
    if (!api.isFunctionDeclaration(fn_)) return false;
    const f = fn_.data.func;
    if (f.body != null) return false;
    const name_node = f.name orelse return false;
    const name = api.text(name_node) orelse return false;
    if (api.typeArgsPresent(f.type_params)) return false;
    const parent = fn_.parent orelse return false;
    const statements: []const *Node = switch (parent.data) {
        .source_file => |x| x.stmts,
        .block => |x| x.stmts,
        .module_block => |x| x.stmts,
        .case_clause => |x| x.stmts,
        .default_clause => |x| x.stmts,
        else => return false,
    };
    for (statements) |s| {
        if (s == fn_ or !api.isFunctionDeclaration(s)) continue;
        const other = s.data.func;
        if (other.name != null and api.identifierIs(other.name.?, name) and other.body != null and !api.typeArgsPresent(other.type_params)) return true;
    }
    return false;
}

pub fn gateFunction(g: *Gate, fn_: *Node) Result {
    const f = fn_.data.func;
    if (api.isFunctionDeclaration(fn_) and extern_.isExternDeclaration(g, fn_)) {
        return api.never("STA1121", "extern declaration is only legal in a .d.ts file; move it there (docs/FFI.md)");
    }
    if (!api.isArrowFunction(fn_) and f.asterisk and fn_.mods.async) return generatorNotYet(g);
    const generic = f.type_params.items.len > 0;
    if (generic and !api.isFunctionDeclaration(fn_) and generics.genericArrowKey(g, fn_) == null and generics.inlineGenericTuple(g, fn_) == null) {
        return g.notYet("a generic function expression or arrow outside a `const` (or single-assignment `let`) binding has no specialization home: no parameter type to read a tuple from and no stable key to lower a second copy under", 5);
    }
    if (f.body == null) {
        return if (hasFunctionImplementation(fn_)) accept else g.notYet("overload signatures are not yet supported", 5);
    }
    if (generic and generics.capturesEnclosingScope(g, fn_)) {
        return g.notYet("a generic function that reads an enclosing scope or a same-file binding is not yet supported", 5);
    }
    return accept;
}

pub fn generatorNotYet(_: *const Gate) Result {
    return api.notYetCode("STA1201", "generators are not yet supported; planned for Phase 5 (the iterator protocol)", 5);
}

pub fn gateYield(g: *Gate, node: *Node) Result {
    if (node.data.yield_expr.star) return g.notYet("yield* is not yet supported", 5);
    var cursor = node.parent;
    while (cursor) |n| : (cursor = n.parent) {
        if (api.isFunctionDeclaration(n) or api.isFunctionExpression(n) or api.isMethodDeclaration(n)) {
            return if (n.data.func.asterisk) accept else g.notYet("yield outside a generator is not yet supported", 5);
        }
        if (api.isArrowFunction(n) or api.isConstructor(n)) break;
    }
    return g.notYet("yield outside a generator is not yet supported", 5);
}

pub fn gateAwait(g: *Gate, node: *Node) Result {
    var cursor = node.parent;
    while (cursor) |n| : (cursor = n.parent) {
        if (api.isFunctionLike(n)) {
            return if (n.mods.async) accept else g.notYet("await outside an async function is not yet supported", 5);
        }
    }
    return accept;
}

pub fn gateTypeParameter(g: *Gate, parameter: *Node) Result {
    const owner = parameter.parent orelse return accept;
    if (api.isMethodDeclaration(owner)) {
        const name = api.text(parameter.data.type_param.name) orelse return accept;
        for (owner.data.func.type_params.items) |p| {
            if (p == parameter and mentionsTypeParameter(owner, name)) return g.notYet("a generic method is not yet supported", 5);
        }
    }
    return accept;
}

fn typeParameterStep(name: []const u8, node: *Node) ast_walk.Step {
    if (node.data == .type_param) return .skip;
    return if (node.data == .type_ref and api.identifierIs(node.data.type_ref.name, name)) .match else .descend;
}

fn mentionsTypeParameter(root: *Node, name: []const u8) bool {
    return ast_walk.contains(root, name, typeParameterStep);
}

pub fn gateParameter(g: *Gate, param: *Node) Result {
    const p = param.data.param;
    if (p.dotdotdot) {
        if (!api.isIdentifier(p.name) or p.init != null) return g.notYet("a rest parameter with a pattern or a default is not yet supported", 5);
        return accept;
    }
    if (!core.isSimpleBindingPattern(g, p.name)) {
        return g.notYet("a computed key with a runtime name in a destructuring parameter is not yet supported", 5);
    }
    if (api.identifierIs(p.name, "this")) return g.notYet("a `this` parameter is not yet supported", 5);
    return accept;
}
