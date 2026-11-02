//! Statements, declarations and the loops that bind names.
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
const Span = c.Span;
const E = c.E;
const H = c.H;
const N = c.N;
const gt = c.gt;
const boundary = @import("boundary.zig");
const expressions = @import("expressions.zig");
const assign = @import("assign.zig");
const patterns = @import("patterns.zig");
const classes = @import("classes.zig");
const functions = @import("functions.zig");
const hoist = @import("hoist.zig");
const generics = @import("../frontend/gate_generics.zig");
const module_names = @import("module_names.zig");
const specialize = @import("specialize.zig");
const members = @import("members.zig");
const lowerExpression = expressions.lowerExpression;
const CATCH_VALUE = " catch";

pub fn lowerStatement(l: *Lower, node: *Node, b: *Scope, label: ?[]const u8) E!Statement {
    const span_of = struct {
        fn at(ll: *Lower, n: *Node) Span {
            return ll.span(n);
        }
    }.at;
    switch (node.data) {
        .var_stmt => |x| return lowerDeclarationList(l, x.list, node, b),
        .expr_stmt => |x| {
            if (x.expr.data == .call and x.expr.data.call.callee.data == .super_expr) return classes.lowerSuperCall(l, x.expr, node, b);
            return assign.lowerExpressionAsStatement(l, x.expr, node, b);
        },
        .if_stmt => |x| {
            const condition = try lowerExpression(l, x.cond, b);
            const consequent = try lowerBody(l, x.then, b);
            const alternate = if (x.els) |e| try lowerBody(l, e, b) else null;
            return l.st(.if_statement, .{ .type = c.H_UNDEFINED, .span = span_of(l, node), .condition = condition, .consequent = consequent, .alternate = alternate });
        },
        inline .while_stmt, .do_stmt => |x, kind| {
            const condition = try lowerExpression(l, x.cond, b);
            const body = try lowerBody(l, x.body, b);
            const tag = if (kind == .while_stmt) .while_statement else .do_while_statement;
            return l.st(tag, .{ .type = c.H_UNDEFINED, .span = span_of(l, node), .condition = condition, .body = body, .label = label, .per_iteration_env = perIteration(l, node) });
        },
        .for_stmt => return lowerFor(l, node, b, label),
        .for_of => return lowerForOf(l, node, b, label),
        .for_in => return assign.lowerForIn(l, node, b, label),
        .switch_stmt => return lowerSwitch(l, node, b, label),
        .class => {
            if (specialize.isGenericClass(node)) {
                const mine = specialize.specsOf(l, l.current_file_class_specs, node);
                const lowered = try classes.lowerGenericClassDeclaration(l, node, mine, b);
                if (lowered.len == 1) return lowered[0];
                return l.st(.block, .{ .type = c.H_UNDEFINED, .span = span_of(l, node), .flatten = true, .statements = lowered });
            }
            return classes.lowerClass(l, node, b);
        },
        .throw_stmt => |x| {
            const value = try lowerExpression(l, x.expr, b);
            return l.st(.throw_statement, .{ .type = c.H_UNDEFINED, .span = span_of(l, node), .value = value });
        },
        .try_stmt => |x| return lowerTry(l, node, x.block, x.catch_clause, x.finally, b),
        inline .break_stmt, .continue_stmt => |x, kind| {
            const target = if (x.label) |t| t.data.identifier else null;
            const tag = if (kind == .break_stmt) .break_statement else .continue_statement;
            return l.st(tag, .{ .type = c.H_UNDEFINED, .span = span_of(l, node), .label = target });
        },
        .labeled => |x| {
            const name = x.label.data.identifier;
            switch (x.stmt.data) {
                .for_stmt, .for_of, .for_in, .while_stmt, .do_stmt, .switch_stmt => return lowerStatement(l, x.stmt, b, name),
                else => {},
            }
            const lowered = try lowerStatement(l, x.stmt, b, null);
            if (lowered == .block and lowered.block.label == null) {
                var copy = lowered.block.*;
                copy.label = name;
                return .{ .block = l.create(copy) };
            }
            return l.st(.block, .{ .type = c.H_UNDEFINED, .span = span_of(l, node), .label = name, .statements = l.dupe(Statement, &.{lowered}) });
        },
        .block => return .{ .block = try lowerBlock(l, node, b.child()) },
        .func => |x| if (x.kind == .decl) {
            const name = module_names.declaredBindingName(node) orelse return l.internal(node, "STA4031", "function declaration without a name");
            if (x.body == null) return .{ .block = emptyBlockAt(l, node) };
            var lowered = try functions.lowerFunction(l, node, b);
            if (x.name == null and lowered.name == null) {
                const copy = l.create(lowered.*);
                copy.name = "default";
                lowered = copy;
            }
            return l.st(.function_declaration, .{ .type = c.H_UNDEFINED, .span = span_of(l, node), .name = b.hirName(name), .@"fn" = lowered });
        },
        .return_stmt => |x| {
            var value: ?Expression = null;
            if (x.expr) |e| value = boundary.returnBoundary(l, try lowerExpression(l, e, b), e);
            return l.st(.return_statement, .{ .type = c.H_UNDEFINED, .span = span_of(l, node), .value = value });
        },
        .empty_stmt, .interface, .type_alias => return .{ .block = emptyBlockAt(l, node) },
        else => {},
    }
    return l.internal(node, "STA4031", l.fmt("unexpected statement kind: {s}", .{@tagName(node.data)}));
}

fn perIteration(l: *Lower, loop: *Node) ?bool {
    return if (assign.loopNeedsPerIterationEnv(l, loop)) true else null;
}

fn lowerTry(l: *Lower, node: *Node, try_node: *Node, catch_clause: ?*Node, finally: ?*Node, b: *Scope) E!Statement {
    const try_block = try lowerBlock(l, try_node, b.child());
    var catch_binding: ?[]const u8 = null;
    var catch_block: ?*const Block = null;
    if (catch_clause) |clause_node| {
        const clause = clause_node.data.catch_clause;
        const scope = b.child();
        const declared: ?*Node = if (clause.decl) |d| d.data.var_decl.name else null;
        if (declared) |name| {
            if (name.data == .identifier) {
                catch_binding = scope.declare(name.data.identifier, c.hUnknown(false));
                l.setHirName(name, catch_binding.?);
            } else {
                catch_binding = CATCH_VALUE;
                scope.set(CATCH_VALUE, c.hUnknown(false));
                assign.bindPatternNames(l, name, scope);
            }
        }
        const lowered = try lowerBlock(l, clause.block, scope);
        if (declared != null and declared.?.data != .identifier and catch_binding != null) {
            const name = declared.?;
            const src = l.ident(c.hUnknown(false), l.span(name), catch_binding.?);
            const parts = try patterns.lowerBindingPattern(l, name, src, .let, name, scope);
            var copy = lowered.*;
            copy.statements = std.mem.concat(l.a, Statement, &.{ parts, lowered.statements }) catch c.oom();
            catch_block = l.create(copy);
        } else catch_block = lowered;
    }
    const finally_block = if (finally) |f| try lowerBlock(l, f, b.child()) else null;
    return l.st(.try_statement, .{ .type = c.H_UNDEFINED, .span = l.span(node), .try_block = try_block, .catch_binding = catch_binding, .catch_block = catch_block, .finally_block = finally_block });
}

pub fn emptyBlockAt(l: *Lower, at: *const Node) *const Block {
    return l.block(l.span(at), &.{});
}

pub fn withDisplayName(l: *Lower, value: Expression, name: []const u8) Expression {
    if (value != .function or value.function.name != null) return value;
    const copy = l.create(value.function.*);
    copy.name = name;
    return .{ .function = copy };
}

pub fn classFormation(l: *Lower, decl: *Node) ?*Node {
    const init = decl.data.var_decl.init orelse return null;
    if (init.data != .class or !init.data.class.is_expr) return null;
    if (!gt.isClassFormationDeclarator(l.g, decl) or gt.expressionClassName(init) == null) return null;
    return init;
}

pub fn lowerDeclarationList(l: *Lower, list: *Node, at: *Node, b: *Scope) E!Statement {
    const declarations = list.data.var_list.decls;
    if (declarations.len == 0) return l.internal(at, "STA4032", "empty variable declaration list");
    if (declarations.len == 1 and classFormation(l, declarations[0]) != null) return lowerDeclarator(l, declarations[0], .let, at, b);
    if (list.data.var_list.kind == .@"var") return hoist.lowerVarList(l, list, at, b);
    const decl_kind: N.DeclKind = if (list.data.var_list.kind == .@"const") .@"const" else .let;
    if (declarations.len == 1) return lowerDeclarator(l, declarations[0], decl_kind, at, b);
    var statements: StmtList = .empty;
    for (declarations) |decl| l.push(&statements, try lowerDeclarator(l, decl, decl_kind, decl, b));
    return l.st(.block, .{ .type = c.H_UNDEFINED, .span = l.span(at), .statements = statements.items, .flatten = true });
}

fn flatBlock(l: *Lower, at: *Node, statements: []const Statement) Statement {
    return l.st(.block, .{ .type = c.H_UNDEFINED, .span = l.span(at), .statements = statements, .flatten = true });
}

pub fn lowerDeclarator(l: *Lower, decl: *Node, decl_kind: N.DeclKind, at: *Node, b: *Scope) E!Statement {
    const d = decl.data.var_decl;
    if (d.name.data != .identifier) {
        if (!c.gate.isSimpleBindingPattern(l.g, d.name) or d.init == null) return l.internal(decl, "STA4032", "destructuring declaration without initializer");
        const lowered = try lowerExpression(l, d.init.?, b);
        const parts = try patterns.lowerBindingPattern(l, d.name, lowered, decl_kind, at, b);
        if (parts.len == 1) return parts[0];
        return flatBlock(l, at, parts);
    }
    const name = d.name.data.identifier;
    if (d.init) |init| if (init.data == .identifier and gt.isSingleConstDeclarator(decl) and
        (generics.genericAliasTarget(l.g, init) != null or gt.aliasedClassDeclaration(l.g, init) != null))
    {
        return flatBlock(l, at, &.{});
    };
    if (classFormation(l, decl)) |formation| return classes.lowerClass(l, formation, b);
    if (d.init) |init| if (generics.genericArrowKey(l.g, init) != null) return flatBlock(l, at, &.{});
    const t = expressions.typeAt(l, d.name, b);
    const hir_name = b.declare(name, t);
    l.setHirName(decl, hir_name);
    var injected_out_new = false;
    if (d.init == null) if (c.ast.writtenType(decl, d.type)) |annotation| {
        if (gt.outSlotInner(l.g, l.g.typeFromNode(annotation)) != null) injected_out_new = true;
    };
    var value: ?Expression = null;
    if (injected_out_new) {
        value = l.ex(.out_new, .{ .type = c.hUnknown(false), .span = l.span(at) });
    } else if (d.init) |init| {
        const lowered = try lowerExpression(l, init, b);
        value = boundary.maybeBoundary(l, withDisplayName(l, lowered, name), t, init, true);
    }
    return l.st(.declaration, .{ .type = t, .span = l.span(at), .name = hir_name, .decl_kind = decl_kind, .value = value });
}

const Peeled = struct { view: N.IteratorView, inner: *Node };

fn peelIteratorView(l: *Lower, e: *Node, b: *Scope) ?Peeled {
    if (e.data != .call or e.data.call.args.len != 0) return null;
    const callee = e.data.call.callee;
    if (callee.data != .prop_access) return null;
    const member = callee.data.prop_access;
    const name = switch (member.name.data) {
        .identifier, .private_name => |x| x,
        else => return null,
    };
    const view: N.IteratorView = if (c.eql(name, "keys")) .keys else if (c.eql(name, "values")) .values else if (c.eql(name, "entries")) .entries else return null;
    const receiver = expressions.typeAt(l, member.expr, b);
    if (receiver.* != .array and receiver.* != .map and receiver.* != .set) return null;
    return .{ .view = view, .inner = member.expr };
}

fn wrapUserIterator(l: *Lower, iterable: Expression, receiver: *Node, at: *Node) E!Expression {
    const t = iterable.getType();
    const method = gt.userIteratorMethod(t) orelse return iterable;
    if (method.type.* != .@"fn") return iterable;
    const name = gt.iterator_method_name;
    const owner = members.declaringClassName(l, receiver, name, null) orelse
        return l.internal(at, "STA4065", l.fmt("no class in the receiver's ancestry declares method '{s}'", .{name}));
    var slot: ?usize = null;
    if (t.* == .object) for (t.object.methods, 0..) |m, i| {
        if (c.eql(m.name, name)) {
            slot = i;
            break;
        }
    };
    if (slot == null) return l.internal(at, "STA4067", l.fmt("method '{s}' has no slot in the layout of {s}", .{ name, l.hTypeName(t) }));
    const dispatch: N.Dispatch = if (t.* == .object and members.isOverridden(l, t.object.name, name)) .virtual else .direct;
    return l.ex(.method_call, .{ .type = method.type.@"fn".ret, .span = iterable.getSpan(), .target = iterable, .class_name = owner, .method = name, .slot = @intCast(slot.?), .dispatch = dispatch, .args = &.{} });
}

fn wrapDynamicIterator(l: *Lower, iterable: Expression) Expression {
    const t = iterable.getType();
    switch (t.*) {
        .array, .string, .map, .set, .iterator => return iterable,
        else => {},
    }
    if (gt.userIteratorMethod(t) != null) return iterable;
    return l.ex(.get_iterator, .{ .type = l.hIterator(if (t.* == .uint8array) c.H_NUMBER else c.hUnknown(false)), .span = iterable.getSpan(), .target = iterable });
}

fn lowerForOf(l: *Lower, node: *Node, b: *Scope, label: ?[]const u8) E!Statement {
    const f = node.data.for_of;
    const peeled = peelIteratorView(l, f.expr, b);
    const iterable_expr = if (peeled) |p| p.inner else f.expr;
    const lowered = try lowerExpression(l, iterable_expr, b);
    const iterable = if (peeled == null) try wrapUserIterator(l, lowered, iterable_expr, node) else lowered;
    const dispatched = wrapDynamicIterator(l, iterable);
    const view: N.IteratorView = if (peeled) |p| p.view else .identity;
    const list = f.init;
    if (list.data == .identifier) {
        const span = l.span(node);
        const temp = l.nextBindTemp();
        const element_type = N.forOfElementType(dispatched.getType(), view);
        const inner = b.child();
        inner.set(temp, element_type);
        const assignment = assign.identifierAssignment(l, list, assign.SameValue{ .value = l.ident(element_type, span, temp) }, inner);
        const body = lowerBody(l, f.body, inner);
        const parts = try assignment;
        const lowered_body = try body;
        var copy = lowered_body.*;
        copy.statements = std.mem.concat(l.a, Statement, &.{ &.{assign.assignmentStatement(l, parts, span)}, lowered_body.statements }) catch c.oom();
        return l.st(.for_of_statement, .{ .type = c.H_UNDEFINED, .span = span, .binding = temp, .decl_kind = .@"const", .iterable = dispatched, .view = view, .body = l.create(copy), .label = label });
    }
    const declaration: ?*Node = if (list.data == .var_list and list.data.var_list.decls.len > 0) list.data.var_list.decls[0] else null;
    if (declaration == null or declaration.?.data.var_decl.name.data != .identifier) return l.internal(node, "STA4035", "for-of binding must be a single named declaration");
    const binding = declaration.?.data.var_decl.name.data.identifier;
    const inner = b.child();
    const hir_binding = inner.declare(binding, N.forOfElementType(dispatched.getType(), view));
    l.setHirName(declaration.?, hir_binding);
    const body = try lowerBody(l, f.body, inner);
    return l.st(.for_of_statement, .{ .type = c.H_UNDEFINED, .span = l.span(node), .binding = hir_binding, .decl_kind = if (list.data.var_list.kind == .@"const") .@"const" else .let, .iterable = dispatched, .view = view, .body = body, .label = label, .per_iteration_env = perIteration(l, node) });
}

fn lowerFor(l: *Lower, node: *Node, b: *Scope, label: ?[]const u8) E!Statement {
    const f = node.data.for_stmt;
    const inner = b.child();
    var init: ?Statement = null;
    if (f.init) |i| init = if (i.data == .var_list) try lowerDeclarationList(l, i, i, inner) else try assign.lowerExpressionAsStatement(l, i, i, inner);
    const condition = if (f.cond) |x| try lowerExpression(l, x, inner) else null;
    const update = if (f.update) |u| try assign.lowerExpressionAsStatement(l, u, u, inner) else null;
    const body = try lowerBody(l, f.body, inner);
    return l.st(.for_statement, .{ .type = c.H_UNDEFINED, .span = l.span(node), .init = init, .condition = condition, .update = update, .body = body, .label = label, .per_iteration_env = perIteration(l, node) });
}

fn clauseStatements(clause: *const Node) []const *Node {
    return if (clause.data == .case_clause) clause.data.case_clause.stmts else clause.data.default_clause.stmts;
}

fn lowerSwitch(l: *Lower, node: *Node, b: *Scope, label: ?[]const u8) E!Statement {
    const s = node.data.switch_stmt;
    const discriminant = try lowerExpression(l, s.expr, b);
    const inner = b.child();
    for (s.clauses) |clause| hoist.hoistFunctionDeclarations(l, clauseStatements(clause), inner);
    var clauses: std.ArrayList(N.SwitchClause) = .empty;
    for (s.clauses) |clause| {
        const t = if (clause.data == .case_clause) try lowerExpression(l, clause.data.case_clause.expr, inner) else null;
        var statements: StmtList = .empty;
        for (clauseStatements(clause)) |child| l.push(&statements, try lowerStatement(l, child, inner, null));
        l.push(&clauses, N.SwitchClause{ .@"test" = t, .statements = statements.items });
    }
    return l.st(.switch_statement, .{ .type = c.H_UNDEFINED, .span = l.span(node), .discriminant = discriminant, .clauses = clauses.items, .label = label });
}

pub const lowerBody = assign.lowerBody;
pub const lowerBlock = assign.lowerBlock;
