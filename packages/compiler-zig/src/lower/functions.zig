//! Function-like declarations: parameters, the body, and what the emitter needs about the frame.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Scope = c.Scope;
const Expression = c.Expression;
const Statement = c.Statement;
const Block = c.Block;
const StmtList = c.StmtList;
const HType = c.HType;
const E = c.E;
const H = c.H;
const N = c.N;
const captures = c.captures;
const expressions = @import("expressions.zig");
const statements = @import("statements.zig");
const assign = @import("assign.zig");
const patterns = @import("patterns.zig");
const hoist = @import("hoist.zig");
const boundary = @import("boundary.zig");
const ast_walk = @import("../support/ast_walk.zig");

fn hasExplicitThisParam(f: *const c.ast.Func) bool {
    if (f.params.len == 0) return false;
    const first = f.params[0].data.param.name;
    return first.data == .identifier and c.eql(first.data.identifier, "this");
}

const bindsThis = c.api.funcKindIn(&.{ .decl, .expr, .method, .ctor, .getter, .setter });

/// A `this` whose binding function is `function`; a nested function that binds its own is skipped.
fn thisOfStep(function: *Node, n: *Node) ast_walk.Step {
    if (n.data != .this_expr) return if (bindsThis(n)) .skip else .descend;
    var at: ?*Node = n.parent;
    while (at) |p| : (at = p.parent) {
        if (c.api.isArrowFunction(p)) continue;
        if (bindsThis(p)) return if (p == function) .match else .skip;
        if (p.data == .source_file or p.data == .class or p.data == .property_decl) break;
    }
    return .skip;
}

fn functionNeedsDynamicThis(node: *Node) bool {
    return ast_walk.contains(node, node, thisOfStep);
}

pub fn bindOneParameter(l: *Lower, param: *Node, t: *const HType, inner: *Scope, default: ?Expression, params: *std.ArrayList(N.Parameter)) ?[]const u8 {
    const p = param.data.param;
    const span = l.span(param);
    const rest: ?bool = if (p.dotdotdot) true else null;
    if (p.name.data == .identifier) {
        const hir = inner.declare(p.name.data.identifier, t);
        l.setHirName(param, hir);
        l.push(params, N.Parameter{ .name = hir, .type = t, .span = span, .rest = rest, .default = default });
        return null;
    }
    const tmp = l.nextBindTemp();
    inner.set(tmp, t);
    l.push(params, N.Parameter{ .name = tmp, .type = t, .span = span, .rest = rest, .default = default });
    return tmp;
}

fn isAnnotated(param: *const Node) bool {
    return param.data.param.type != null;
}

pub fn provenanceOf(f: *const c.ast.Func, params: []const N.Parameter, t: *const HType) N.Provenance {
    const ret = if (t.* == .@"fn") t.@"fn".ret else c.H_UNDEFINED;
    for (params) |p| if (H.hTypeHasUnknown(p.type)) return .dynamic;
    if (H.hTypeHasUnknown(ret)) return .dynamic;
    for (f.params) |p| if (!isAnnotated(p)) return .inferred;
    return if (f.kind == .ctor or f.ret != null) .typed else .inferred;
}

pub fn lowerFunctionBody(l: *Lower, body_node: ?*Node, b: *Scope, owner: *Node) E!*const Block {
    const body = body_node orelse return l.internal(owner, "STA4030", "function has no body");
    if (body.data == .block) {
        const body_scope = b.child();
        hoist.hoistFunctionDeclarations(l, body.data.block.stmts, body_scope);
        const hoisted = hoist.hoistVarDeclarations(l, body, false, body_scope);
        const lowered = try assign.lowerBlock(l, body, body_scope);
        if (hoisted.len == 0) return lowered;
        var all: StmtList = .empty;
        l.a_appendAll(&all, hoisted);
        l.a_appendAll(&all, lowered.statements);
        const copy = l.create(lowered.*);
        copy.statements = all.items;
        return copy;
    }
    const lowered = try expressions.lowerExpression(l, body, b);
    const value = if (owner.data.func.kind == .arrow and c.hasTypeScriptAnnotation(l, owner)) boundary.returnBoundary(l, lowered, body) else lowered;
    const span = l.span(body);
    const statements_out = l.dupe(Statement, &.{l.st(.return_statement, .{ .type = c.H_UNDEFINED, .span = span, .value = value })});
    return l.block(span, statements_out);
}

pub fn lowerFunction(l: *Lower, node: *Node, b: *Scope) E!*const N.FunctionExpr {
    return lowerFunctionWith(l, node, b, null);
}

pub fn lowerFunctionWith(l: *Lower, node: *Node, b: *Scope, receiver: ?*const HType) E!*const N.FunctionExpr {
    l.function_nesting += 1;
    defer l.function_nesting -= 1;
    const f = node.data.func;
    const inner = b.functionScope();
    var params: std.ArrayList(N.Parameter) = .empty;
    const is_plain = f.kind == .decl or f.kind == .expr;
    var effective = receiver;
    if (effective == null and is_plain and !hasExplicitThisParam(f) and functionNeedsDynamicThis(node)) effective = c.hUnknown(false);
    if (effective) |r| {
        const at = l.makeSpan(node.start, node.start);
        l.push(&params, N.Parameter{ .name = captures.RECEIVER_NAME, .type = r, .span = at });
        inner.set(captures.RECEIVER_NAME, r);
    }
    const Destructured = struct { name: *Node, tmp: []const u8 };
    var destructured: std.ArrayList(Destructured) = .empty;
    for (f.params) |param| {
        const t = expressions.typeAt(l, param, b);
        const default: ?Expression = if (param.data.param.init) |init| try expressions.lowerExpression(l, init, inner) else null;
        if (bindOneParameter(l, param, t, inner, default, &params)) |tmp| {
            l.push(&destructured, Destructured{ .name = param.data.param.name, .tmp = tmp });
            assign.bindPatternNames(l, param.data.param.name, inner);
        }
    }
    const span = l.span(node);
    const declared = expressions.typeAt(l, node, b);
    var t = declared;
    if (effective != null and !is_plain) {
        const list = l.a.alloc(*const HType, params.items.len) catch c.oom();
        for (params.items, list) |p, *out| out.* = p.type;
        t = l.hFunction(list, if (declared.* == .@"fn") declared.@"fn".ret else c.H_UNDEFINED);
    }
    var self_binding: ?[]const u8 = null;
    if (f.kind == .expr) if (f.name) |name| if (name.data == .identifier) {
        const hir = inner.declare(name.data.identifier, t);
        self_binding = hir;
        l.immutable_self_bindings.put(l.a, hir, {}) catch c.oom();
        l.setHirName(name, hir);
    };
    var unpacked: StmtList = .empty;
    for (destructured.items) |item| {
        const src = l.ident(inner.get(item.tmp) orelse c.hUnknown(false), span, item.tmp);
        l.a_appendAll(&unpacked, try patterns.lowerBindingPattern(l, item.name, src, .let, item.name, inner));
    }
    var body = try lowerFunctionBody(l, f.body, inner, node);
    if (unpacked.items.len != 0) {
        l.a_appendAll(&unpacked, body.statements);
        const copy = l.create(body.*);
        copy.statements = unpacked.items;
        body = copy;
    }
    const info = l.capturesFor(l.sf).get(node);
    const is_async = node.mods.async;
    const is_generator = (f.kind == .decl or f.kind == .expr or f.kind == .method) and f.asterisk;
    var env_vars: []const []const u8 = &.{};
    var capture_list: []const N.EnvCapture = &.{};
    if (info) |x| {
        env_vars = envNames(l, &x);
        const out = l.a.alloc(N.EnvCapture, x.captures.len) catch c.oom();
        for (x.captures, out) |capture, *slot| slot.* = .{ .name = l.hirNameOf(capture.decl) orelse capture.name, .levels = capture.levels, .index = capture.index };
        capture_list = out;
    }
    const out = l.create(N.FunctionExpr{
        .type = t,
        .span = span,
        .name = if (f.kind != .ctor) if (f.name) |n| (if (n.data == .identifier) n.data.identifier else null) else null else null,
        .self_binding = self_binding,
        .params = params.items,
        .body = body,
        .is_async = is_async,
        .is_generator = is_generator,
        .constructible = if (is_plain and !is_async and !is_generator) true else null,
        .env_vars = env_vars,
        .captures = capture_list,
        .needs_env = if (info) |x| x.needs_env else false,
        .provenance = provenanceOf(f, params.items, t),
    });
    return out;
}

pub fn envNames(l: *Lower, info: *const captures.CaptureInfo) []const []const u8 {
    const out = l.a.alloc([]const u8, info.env_vars.len) catch c.oom();
    for (info.env_vars, info.env_decls, out) |name, decl, *slot| slot.* = l.hirNameOf(decl) orelse name;
    return out;
}
