//! Runtime checks where a value crosses from unchecked to checked code.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Expression = c.Expression;
const HType = c.HType;
const H = c.H;
const gt = c.gt;
const narrowing = c.narrowing;
const expressions = @import("expressions.zig");

pub fn checkCallArgs(l: *Lower, signature: ?*const HType, args: []const Expression, node: *Node) []const Expression {
    const sites = callArguments(node);
    var has_spread = false;
    for (sites) |s| if (s.data == .spread_elem) {
        has_spread = true;
    };
    const callee = if (has_spread) null else calleeParameters(l, node);
    var declared: ?[]const *Node = null;
    if (callee) |x| if (c.isFunctionLike(x.declaration) and x.declaration.data.func.body != null) {
        declared = x.parameters;
    };
    const out = l.a.alloc(Expression, args.len) catch c.oom();
    for (args, out, 0..) |arg, *slot, i| {
        const site = if (i < sites.len) sites[i] else null;
        const param = if (declared) |d| (if (i < d.len) d[i] else null) else null;
        const annotation = if (param) |p| c.ast.writtenType(p, p.data.param.type) else null;
        var expected: ?*const HType = null;
        if (signature != null and signature.?.* == .@"fn") {
            const params = signature.?.@"fn".params;
            if (i < params.len) expected = params[i];
        } else if (annotation) |a| expected = l.toH(l.g.typeFromNode(a));
        if (expected == null or site == null) {
            slot.* = arg;
            continue;
        }
        slot.* = maybeBoundary(l, arg, expected.?, site.?, param != null and !param.?.data.param.dotdotdot and c.hasTypeScriptAnnotation(l, param.?));
    }
    return out;
}

pub fn callArguments(node: *const Node) []const *Node {
    return switch (node.data) {
        .call => |x| x.args,
        .new_expr => |x| x.args,
        else => &.{},
    };
}

pub fn returnBoundary(l: *Lower, value: Expression, expression: *Node) Expression {
    const contextual = l.g.contextualType(expression) orelse return value;
    const expected = l.toH(contextual);
    const f = c.captures.enclosingFunction(expression);
    const annotated = if (f) |x| !x.data.func.asterisk and !x.mods.async and c.hasTypeScriptAnnotation(l, x) else false;
    return maybeBoundary(l, value, expected, expression, annotated);
}

/// At an annotated edge a typed value that does not fit the annotation is checked too, since the
/// annotation is what the callee trusts.
pub fn maybeBoundary(l: *Lower, value: Expression, expected: *const HType, node: *const Node, at_edge: bool) Expression {
    const t = value.getType();
    if (!narrowing.isCheckable(expected)) return value;
    if (t.* == .unknown or (at_edge and !H.hTypeAssignable(t, expected))) return boundaryCheck(l, value, expected, node);
    return value;
}

pub fn boundaryCheck(l: *Lower, value: Expression, expected: *const HType, node: *const Node) Expression {
    return l.ex(.boundary_check, .{ .type = expected, .span = l.span(node), .value = value, .where = l.checkLocation(node) });
}

fn staticallySafeValue(value: *const HType, target: *const HType) bool {
    if (value.* == .array and target.* == .array) return H.hTypeEquals(value.array.element, target.array.element);
    if (value.* != .object or target.* != .object) return false;
    if (c.eql(value.object.name, target.object.name)) return true;
    if (std.mem.indexOfScalar(u8, target.object.name, '<') != null) return false;
    for (value.object.bases) |b| if (c.eql(b, target.object.name)) return true;
    return false;
}

pub const Names = c.NameSet;

fn effectiveValueType(l: *Lower, node: *Node, known_dynamic: *const Names, known_return: *const Names) *const HType {
    var current = node;
    while (true) {
        switch (current.data) {
            .paren => |x| {
                current = x.expr;
                continue;
            },
            .non_null => |x| {
                current = x.expr;
                continue;
            },
            .as_expr, .satisfies_expr => {
                const operand = if (current.data == .as_expr) current.data.as_expr.expr else current.data.satisfies_expr.expr;
                const assertion = if (current.data == .as_expr) narrowing.assertedBy(l.g, current) else null;
                const operand_type = effectiveValueType(l, operand, known_dynamic, known_return);
                if (assertion != null and narrowing.isCheckable(assertion.?) and operand_type.* == .unknown) return assertion.?;
                current = operand;
                continue;
            },
            .array_lit => if (expressions.emptyArrayContextType(l, current)) |contextual| return contextual,
            .call => {
                if (known_return.count() > 0) {
                    if (calledFunctionFQN(l, current)) |fqn| {
                        if (known_return.contains(fqn)) return c.hUnknown(false);
                    }
                }
                return l.hAt(current);
            },
            .identifier => if (l.g.symbolAt(current)) |symbol| {
                if (known_dynamic.contains(l.fqn(symbol))) return c.hUnknown(false);
                if (symbol.value_decl != null) {
                    const declared = l.toH(l.g.typeOfSymbol(symbol));
                    return if (declared.* != .unknown) declared else c.hUnknown(false);
                }
            },
            else => {},
        }
        return l.hAt(current);
    }
}

fn isMemberBody(declaration: *const Node) bool {
    if (declaration.data != .func) return false;
    return switch (declaration.data.func.kind) {
        .method, .getter, .setter => true,
        else => false,
    };
}

const Touch = struct { l: *Lower, param_name: []const u8 };

fn touchStep(w: Touch, node: *Node) c.support.ast_walk.Step {
    if (node.data != .prop_access or node.data.prop_access.name.data == .private_name) return .descend;
    const receiver = node.data.prop_access.expr;
    const symbol = if (receiver.data == .identifier or receiver.data == .prop_access) w.l.g.symbolAt(receiver) else null;
    if (symbol == null or !c.eql(w.l.fqn(symbol.?), w.param_name)) return .descend;
    const member = w.l.g.property(w.l.g.typeAt(receiver), node.data.prop_access.name.data.identifier) orelse return .match;
    for (api.propDeclarations(member)) |d| if (isMemberBody(d)) return .match;
    return .descend;
}

const api = c.api;

fn paramTouchesMethod(l: *Lower, f: *Node, param: *c.Symbol) bool {
    return c.support.ast_walk.contains(f, Touch{ .l = l, .param_name = l.fqn(param) }, touchStep);
}

pub const Callee = struct { declaration: *Node, parameters: []const *Node };

pub fn calleeParameters(l: *Lower, node: *Node) ?Callee {
    const callee = if (node.data == .call) node.data.call.callee else node.data.new_expr.callee;
    if (c.isFunctionLike(callee)) return .{ .declaration = callee, .parameters = callee.data.func.params };
    const symbol = if (callee.data == .identifier or callee.data == .prop_access) l.g.symbolAt(callee) else null;
    const resolved = calleeTargetDeclaration(l, symbol, 0);
    const declaration = (if (resolved != null or node.data != .new_expr) resolved else constructorOfClass(symbol)) orelse return null;
    if (!c.isFunctionLike(declaration)) return null;
    const params = declaration.data.func.params;
    if (params.len > 0 and params[0].data.param.name.data == .identifier and c.eql(params[0].data.param.name.data.identifier, "this")) {
        return .{ .declaration = declaration, .parameters = params[1..] };
    }
    return .{ .declaration = declaration, .parameters = params };
}

fn constructorOfClass(symbol: ?*c.Symbol) ?*Node {
    const declaration = (symbol orelse return null).value_decl orelse return null;
    if (declaration.data != .class or declaration.data.class.is_expr) return null;
    for (declaration.data.class.members) |m| {
        if (m.data == .func and m.data.func.kind == .ctor) return m;
    }
    return null;
}

fn calleeTargetDeclaration(l: *Lower, symbol: ?*c.Symbol, depth: u32) ?*Node {
    const declaration = (symbol orelse return null).value_decl orelse return null;
    if (depth > 1) return null;
    if (c.isFunctionLike(declaration)) return declaration;
    if (declaration.data == .var_decl) if (declaration.data.var_decl.init) |init| {
        if (c.isFunctionLike(init)) return init;
        if (init.data == .identifier) return calleeTargetDeclaration(l, l.g.symbolAt(init), depth + 1);
    };
    return null;
}

pub const Widening = struct { dynamic: Names, returns: Names };

pub fn collectDynamicWidening(l: *Lower, files: []const *c.File, dynamic: *Names) Names {
    var returns: Names = .empty;
    var seen_return: Names = .empty;
    while (true) {
        const before_slots = dynamic.count();
        const before_returns = returns.count();
        var slots: Marking = .{ .l = l, .known_dynamic = dynamic, .known_return = &seen_return, .fqns = dynamic };
        for (files) |f| slots.visitSlots(f.root);
        var rets: Marking = .{ .l = l, .known_dynamic = dynamic, .known_return = &seen_return, .fqns = &returns };
        for (files) |f| rets.visitReturns(f.root);
        var it = returns.keyIterator();
        while (it.next()) |k| seen_return.put(l.a, k.*, {}) catch c.oom();
        if (dynamic.count() == before_slots and returns.count() == before_returns) return returns;
    }
}

/// One fixpoint round of either marking pass: the sets the round reads, and the one it grows.
const Marking = struct {
    l: *Lower,
    known_dynamic: *const Names,
    known_return: *const Names,
    fqns: *Names,

    fn isSafe(p: *Marking, value: *Node, declared: *const HType) bool {
        return staticallySafeValue(effectiveValueType(p.l, value, p.known_dynamic, p.known_return), declared);
    }

    fn mark(p: *Marking, fqn: []const u8) void {
        p.fqns.put(p.l.a, fqn, {}) catch c.oom();
    }

    fn widenVariableIfUnsafe(p: *Marking, name: *Node, value: *Node) void {
        if (value.data == .object_lit) return;
        const l = p.l;
        const symbol = l.g.symbolAt(name) orelse return;
        if (symbol.value_decl == null) return;
        const declared = l.toH(l.g.typeOfSymbol(symbol));
        if (declared.* != .object) return;
        if (!p.isSafe(value, declared)) p.mark(l.fqn(symbol));
    }

    fn visitSlots(p: *Marking, node: *Node) void {
        const l = p.l;
        switch (node.data) {
            .var_decl => |x| if (x.name.data == .identifier and x.init != null) p.widenVariableIfUnsafe(x.name, x.init.?),
            .binary => |x| if (x.op == .assign and x.left.data == .identifier) p.widenVariableIfUnsafe(x.left, x.right),
            .call, .new_expr => if (calleeParameters(l, node)) |callee| {
                for (callArguments(node), 0..) |argument, index| {
                    if (argument.data == .spread_elem or index >= callee.parameters.len) continue;
                    const param = callee.parameters[index];
                    const name = param.data.param.name;
                    if (name.data != .identifier) continue;
                    const param_symbol = l.g.symbolAt(name) orelse continue;
                    if (param_symbol.value_decl == null) continue;
                    const declared = l.toH(l.g.typeOfSymbol(param_symbol));
                    if (declared.* != .object) continue;
                    if (!p.isSafe(argument, declared) and !paramTouchesMethod(l, callee.declaration, param_symbol)) p.mark(l.fqn(param_symbol));
                }
            },
            else => {},
        }
        c.ast.forEachChild(node, p, visitSlots);
    }

    fn visitFn(p: *Marking, f: *Node) void {
        const l = p.l;
        const fqn = markingFQNOfFunction(l, f) orelse return;
        if (p.fqns.contains(fqn)) return;
        if (f.data.func.kind == .method and p.known_dynamic.contains(fqn)) return p.mark(fqn);
        const target = declaredReturnOf(l, f) orelse return;
        const returned = functionReturnValues(l, f);
        if (returned.bare) return p.mark(fqn);
        for (returned.values.items) |value| {
            if (!p.isSafe(value, target)) return p.mark(fqn);
        }
    }

    fn visitReturns(p: *Marking, node: *Node) void {
        if (c.isFunctionLike(node)) p.visitFn(node);
        c.ast.forEachChild(node, p, visitReturns);
    }
};

fn markingFQNOfFunction(l: *Lower, f: *Node) ?[]const u8 {
    switch (f.data.func.kind) {
        .decl, .method => {
            const name = f.data.func.name orelse return null;
            if (name.data != .identifier) return null;
            return l.fqn(l.g.symbolAt(name) orelse return null);
        },
        .expr, .arrow => {
            const parent = f.parent orelse return null;
            if (parent.data != .var_decl or parent.data.var_decl.name.data != .identifier) return null;
            return l.fqn(l.g.symbolAt(parent.data.var_decl.name) orelse return null);
        },
        else => return null,
    }
}

fn declaredReturnOf(l: *Lower, f: *Node) ?*const HType {
    if (f.data.func.kind == .ctor) return null;
    const t = l.hAt(f);
    if (t.* != .@"fn" or H.hasTypeParam(t.@"fn".ret)) return null;
    const ret = t.@"fn".ret;
    return if (ret.* == .object or ret.* == .array) ret else null;
}

const Returned = struct { values: std.ArrayList(*Node) = .empty, bare: bool = false };

const ReturnWalk = struct {
    l: *Lower,
    out: Returned = .{},

    fn visit(w: *ReturnWalk, node: *Node) void {
        if (c.isFunctionLike(node)) return;
        if (node.data == .return_stmt) {
            if (node.data.return_stmt.expr) |e| w.l.push(&w.out.values, e) else w.out.bare = true;
            return;
        }
        c.ast.forEachChild(node, w, visit);
    }
};

fn functionReturnValues(l: *Lower, f: *Node) Returned {
    const body = f.data.func.body orelse return .{};
    var walk: ReturnWalk = .{ .l = l };
    if (f.data.func.kind == .arrow and body.data != .block) {
        l.push(&walk.out.values, body);
        return walk.out;
    }
    c.ast.forEachChild(body, &walk, ReturnWalk.visit);
    return walk.out;
}

pub fn calledFunctionFQN(l: *Lower, node: *Node) ?[]const u8 {
    const callee = node.data.call.callee;
    const symbol = if (callee.data == .identifier or callee.data == .prop_access) l.g.symbolAt(callee) else null;
    const resolved = calleeTargetDeclaration(l, symbol, 0) orelse return null;
    if (!c.isFunctionLike(resolved)) return null;
    return markingFQNOfFunction(l, resolved);
}
