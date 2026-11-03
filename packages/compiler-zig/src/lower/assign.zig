//! Assignment in all its forms: to names, to places, through destructuring, and as an expression.
const std = @import("std");
const c = @import("ctx.zig");
const ast_walk = c.support.ast_walk;
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
const Tok = c.Tok;
const gt = c.gt;
const boundary = @import("boundary.zig");
const expressions = @import("expressions.zig");
const patterns = @import("patterns.zig");
const statements_mod = @import("statements.zig");
const members = @import("members.zig");
const classes = @import("classes.zig");
const hoist = @import("hoist.zig");
const lowerExpression = expressions.lowerExpression;
const withDisplayName = statements_mod.withDisplayName;
const typeAt = expressions.typeAt;

pub const Assign = struct { target: []const u8, value: Expression };

const compoundOperator = expressions.compoundOperator;
const logicalAssignOperator = expressions.logicalAssignOperator;

pub const Update = struct { operand: *Node, operator: N.BinaryOperator };

pub fn updateOperator(e: *const Node) ?Update {
    const op: Tok, const operand: *Node = switch (e.data) {
        .postfix => |x| .{ x.op, x.expr },
        .prefix => |x| .{ x.op, x.expr },
        else => return null,
    };
    if (op == .plus2) return .{ .operand = operand, .operator = .@"+" };
    if (op == .minus2) return .{ .operand = operand, .operator = .@"-" };
    return null;
}

pub const OperatorKinds = struct { compound: ?N.BinaryOperator = null, logical: ?N.LogicalOperator = null };

pub fn assignOperatorKinds(e: *const Node) OperatorKinds {
    if (e.data != .binary) return .{};
    return .{ .compound = compoundOperator(e.data.binary.op), .logical = logicalAssignOperator(e.data.binary.op) };
}

fn isPlainAssign(e: *const Node) bool {
    return e.data == .binary and e.data.binary.op == .assign;
}

const LowerRight = struct {
    l: *Lower,
    right: *Node,
    b: *Scope,
    pub fn make(s: @This(), _: Expression) E!Expression {
        return lowerExpression(s.l, s.right, s.b);
    }
};

/// `target op= right` for an arithmetic or a logical operator: the current value combined with the
/// right side.
fn Combine(comptime Operator: type) type {
    return struct {
        l: *Lower,
        e: *Node,
        b: *Scope,
        operator: Operator,
        pub fn make(s: @This(), current: Expression) E!Expression {
            const right = try lowerExpression(s.l, s.e.data.binary.right, s.b);
            const t = typeAt(s.l, s.e, s.b);
            if (Operator == N.LogicalOperator) {
                return s.l.ex(.logical_op, .{ .type = t, .span = current.getSpan(), .operator = s.operator, .left = current, .right = right });
            }
            return c.arithmeticBinOp(s.l, s.operator, current, right, current.getSpan(), t);
        }
    };
}
const Compound = Combine(N.BinaryOperator);
const LogicalAssign = Combine(N.LogicalOperator);

const Bump = struct {
    l: *Lower,
    operator: N.BinaryOperator,
    pub fn make(s: @This(), current: Expression) E!Expression {
        return bumped(s.l, current, s.operator, current.getSpan());
    }
};

fn bumped(l: *Lower, current: Expression, operator: N.BinaryOperator, span: Span) Expression {
    const left = l.ex(.unary_op, .{ .type = c.H_NUMBER, .span = span, .operator = .@"+", .operand = current });
    return l.ex(.binary_op, .{ .type = c.H_NUMBER, .span = span, .operator = operator, .left = left, .right = l.number(span, 1) });
}

pub fn identifierAssignment(l: *Lower, target_node: *Node, maker: anytype, b: *Scope) E!Assign {
    const target = placeName(l, target_node) orelse return l.internal(target_node, "STA4033", "assignment target must be an identifier");
    const binding = b.get(target) orelse return l.internal(target_node, "STA4034", l.fmt("identifier '{s}' assigned before declaration", .{target}));
    const current = l.ident(binding, l.span(target_node), b.hirName(target));
    const raw = try maker.make(current);
    const value = if (target_node.data == .identifier) withDisplayName(l, raw, target_node.data.identifier) else raw;
    return .{ .target = b.hirName(target), .value = boundary.maybeBoundary(l, value, binding, target_node, true) };
}

fn assignmentParts(l: *Lower, e: *Node, b: *Scope) E!?Assign {
    if (e.data == .binary) {
        const x = e.data.binary;
        if (x.op == .assign) return try identifierAssignment(l, x.left, LowerRight{ .l = l, .right = x.right, .b = b }, b);
        if (compoundOperator(x.op)) |operator| return try identifierAssignment(l, x.left, Compound{ .l = l, .e = e, .b = b, .operator = operator }, b);
        if (logicalAssignOperator(x.op)) |operator| return try identifierAssignment(l, x.left, LogicalAssign{ .l = l, .e = e, .b = b, .operator = operator }, b);
        return null;
    }
    const update = updateOperator(e) orelse return null;
    return try identifierAssignment(l, update.operand, Bump{ .l = l, .operator = update.operator }, b);
}

pub fn assignmentStatement(l: *Lower, assignment: Assign, span: Span) Statement {
    if (l.immutable_self_bindings.contains(assignment.target)) {
        const raised = l.ex(.type_error, .{ .type = c.H_UNDEFINED, .span = span, .message = "Assignment to constant variable." });
        return l.st(.expression_statement, .{ .type = c.H_UNDEFINED, .span = span, .expression = raised });
    }
    return l.st(.assignment, .{ .type = assignment.value.getType(), .span = span, .target = assignment.target, .value = assignment.value });
}

fn placeName(l: *Lower, node: *Node) ?[]const u8 {
    if (node.data == .identifier) return node.data.identifier;
    if (node.data != .prop_access) return null;
    const found = gt.staticMemberOf(l.g, node, false) orelse return null;
    if (gt.classDisplayName(found.owner) == null) return null;
    return members.staticName(l, members.hirClassName(l, found.owner), members.propertyText(node));
}

const DestructTarget = struct { key: patterns.Key, name: *Node, at: *Node };

const PatternRead = struct {
    l: *Lower,
    source: Expression,
    key: patterns.Key,
    name: *Node,
    at: *Node,
    b: *Scope,
    pub fn make(s: @This(), _: Expression) E!Expression {
        return patterns.lowerPatternRead(s.l, s.source, s.key, s.name, s.at, s.b, null);
    }
};

fn lowerDestructuringAssignment(l: *Lower, pattern: *Node, rhs_node: *Node, span: Span, b: *Scope) E!Statement {
    const rhs = try lowerExpression(l, rhs_node, b);
    var out: StmtList = .empty;
    const source = patterns.patternSource(l, rhs, span, b, &out);
    var targets: std.ArrayList(DestructTarget) = .empty;
    if (pattern.data == .object_lit) {
        for (pattern.data.object_lit.props) |p| switch (p.data) {
            .shorthand_assign => |x| l.push(&targets, DestructTarget{ .key = .{ .name = x.name.data.identifier }, .name = x.name, .at = p }),
            .property_assign => |x| if (x.name.data == .identifier) l.push(&targets, DestructTarget{ .key = .{ .name = x.name.data.identifier }, .name = x.value, .at = p }),
            else => {},
        };
    } else {
        for (pattern.data.array_lit.elems, 0..) |el, index| {
            if (el.data != .omitted_expr) l.push(&targets, DestructTarget{ .key = .{ .index = @intCast(index) }, .name = el, .at = el });
        }
    }
    for (targets.items) |t| {
        if (t.name.data != .identifier) return l.internal(t.name, "STA4033", "assignment target must be an identifier");
        const parts = try identifierAssignment(l, t.name, PatternRead{ .l = l, .source = source, .key = t.key, .name = t.name, .at = t.at, .b = b }, b);
        l.push(&out, assignmentStatement(l, parts, span));
    }
    return l.st(.block, .{ .type = c.H_UNDEFINED, .span = span, .flatten = true, .statements = out.items });
}

pub fn isUnresolvableIdentifier(l: *Lower, node: *Node, b: *Scope) bool {
    if (b.has(node.data.identifier)) return false;
    // TypeScript's checker has its own symbols for these two; stator-ts answers them by name.
    const symbol = l.g.symbolAt(node) orelse return !c.eql(node.data.identifier, "undefined") and !c.eql(node.data.identifier, "globalThis");
    if (symbol.flags & c.F.assignment == 0 or symbol.decls.len == 0) return false;
    for (symbol.decls) |d| if (d.data != .identifier) return false;
    return true;
}

const Undeclared = struct { node: *Node, rhs: ?*Node = null };

fn undeclaredWriteTarget(l: *Lower, e: *Node, b: *Scope) ?Undeclared {
    const unresolved = struct {
        fn at(ll: *Lower, n: *Node, s: *Scope) ?*Node {
            return if (n.data == .identifier and isUnresolvableIdentifier(ll, n, s)) n else null;
        }
    }.at;
    if (e.data == .binary) {
        const x = e.data.binary;
        const target = unresolved(l, x.left, b) orelse return null;
        if (x.op == .assign) return .{ .node = target, .rhs = x.right };
        return if (compoundOperator(x.op) != null or logicalAssignOperator(x.op) != null) .{ .node = target } else null;
    }
    const update = updateOperator(e) orelse return null;
    return .{ .node = unresolved(l, update.operand, b) orelse return null };
}

pub fn lowerExpressionAsStatement(l: *Lower, e: *Node, at: *Node, b: *Scope) E!Statement {
    const span = l.span(at);
    const bare = c.api.skipParens(e);
    if (isPlainAssign(bare) and (bare.data.binary.left.data == .object_lit or bare.data.binary.left.data == .array_lit)) {
        return lowerDestructuringAssignment(l, bare.data.binary.left, bare.data.binary.right, span, b);
    }
    if (try memberAssignment(l, e, at, b)) |member| return member;
    if (undeclaredWriteTarget(l, e, b)) |undeclared| {
        const raised = l.ex(.reference_error, .{ .type = c.hUnknown(false), .span = l.span(undeclared.node), .name = undeclared.node.data.identifier });
        const thrown = l.st(.expression_statement, .{ .type = c.hUnknown(false), .span = span, .expression = raised });
        const rhs = undeclared.rhs orelse return thrown;
        const value = try lowerExpression(l, rhs, b);
        const first = l.st(.expression_statement, .{ .type = value.getType(), .span = value.getSpan(), .expression = value });
        return l.st(.block, .{ .type = c.hUnknown(false), .span = span, .flatten = true, .statements = l.dupe(Statement, &.{ first, thrown }) });
    }
    if (try assignmentParts(l, e, b)) |assignment| return assignmentStatement(l, assignment, span);
    const exp = try lowerExpression(l, e, b);
    return l.st(.expression_statement, .{ .type = exp.getType(), .span = span, .expression = exp });
}

fn isSideEffectFree(node: *const Node) bool {
    return c.support.node_field.isAny(node, .{ .identifier, .numeric_lit, .string_lit, .true_lit, .false_lit, .null_lit });
}

/// How a place is written, once the value is known.
pub const Write = union(enum) {
    field: struct { target: Expression, field: []const u8, slot: i32 },
    index: struct { target: Expression, index: Expression },
    dyn: struct { target: Expression, field: []const u8 },
    static_accessor: struct { owner: []const u8, property: []const u8, node: *Node, b: *Scope },
    accessor: members.AccessorWrite,

    fn apply(w: Write, l: *Lower, value: Expression, span: Span) Statement {
        return switch (w) {
            .field => |x| l.st(.field_assignment, .{ .type = value.getType(), .span = span, .target = x.target, .field = x.field, .slot = x.slot, .value = value }),
            .index => |x| l.st(.index_assignment, .{ .type = value.getType(), .span = span, .target = x.target, .index = x.index, .value = value }),
            .dyn => |x| l.st(.dyn_field_assignment, .{ .type = value.getType(), .span = span, .target = x.target, .field = x.field, .value = value }),
            .static_accessor => |x| {
                const call = members.staticAccessorCall(l, .set, x.owner, x.property, l.dupe(Expression, &.{value}), c.H_UNDEFINED, span, x.node, x.b) catch
                    return l.st(.expression_statement, .{ .type = c.H_UNDEFINED, .span = span, .expression = value });
                return l.st(.expression_statement, .{ .type = c.H_UNDEFINED, .span = span, .expression = call });
            },
            .accessor => |x| members.accessorWrite(l, x, value, span),
        };
    }
};

pub const Place = struct { current: Expression, write: Write };

const MemberWrite = struct {
    l: *Lower,
    e: *Node,
    b: *Scope,
    span: Span,
    compound: ?N.BinaryOperator,
    logical: ?N.LogicalOperator,
    update: ?Update,

    fn finish(m: MemberWrite, place: Place, prefix: *StmtList) E!?Statement {
        const l = m.l;
        var value: Expression = undefined;
        if (m.update) |update| {
            value = bumped(l, place.current, update.operator, m.span);
        } else if (m.e.data != .binary) {
            return null;
        } else if (m.compound) |operator| {
            const right = try lowerExpression(l, m.e.data.binary.right, m.b);
            value = c.arithmeticBinOp(l, operator, place.current, right, m.span, typeAt(l, m.e, m.b));
        } else if (m.logical) |operator| {
            const right = try lowerExpression(l, m.e.data.binary.right, m.b);
            value = l.ex(.logical_op, .{ .type = typeAt(l, m.e, m.b), .span = m.span, .operator = operator, .left = place.current, .right = right });
        } else {
            value = try lowerExpression(l, m.e.data.binary.right, m.b);
        }
        const stmt = place.write.apply(l, value, m.span);
        if (prefix.items.len == 0) return stmt;
        l.push(prefix, stmt);
        return l.st(.block, .{ .type = c.H_UNDEFINED, .span = m.span, .statements = prefix.items });
    }
};

fn hoisted(l: *Lower, node: *Node, slot: u32, plain: bool, b: *Scope, statements: *StmtList) E!Expression {
    const lowered = try lowerExpression(l, node, b);
    if (plain or isSideEffectFree(node)) return lowered;
    const name = l.fmt(" index{d}", .{slot});
    b.set(name, lowered.getType());
    l.push(statements, l.st(.declaration, .{ .type = lowered.getType(), .span = lowered.getSpan(), .name = name, .decl_kind = .@"const", .value = lowered }));
    return l.ident(lowered.getType(), lowered.getSpan(), name);
}

fn memberAssignment(l: *Lower, e: *Node, at: *Node, b: *Scope) E!?Statement {
    const span = l.span(at);
    const kinds = assignOperatorKinds(e);
    const update = updateOperator(e);
    const plain = isPlainAssign(e);
    const target_node: *Node = if (e.data == .binary) e.data.binary.left else if (update) |u| u.operand else return null;
    if (target_node.data != .elem_access and target_node.data != .prop_access) return null;
    if (!plain and kinds.compound == null and kinds.logical == null and update == null) return null;
    const is_prop = target_node.data == .prop_access;
    const m: MemberWrite = .{ .l = l, .e = e, .b = b, .span = span, .compound = kinds.compound, .logical = kinds.logical, .update = update };
    var none: StmtList = .empty;

    const static_found = if (is_prop) gt.staticMemberOf(l.g, target_node, null) else null;
    if (static_found != null and gt.classDisplayName(static_found.?.owner) != null and members.isAccessorMember(static_found.?.member)) {
        const owner = members.hirClassName(l, static_found.?.owner);
        const property = members.propertyText(target_node);
        const halves = members.staticAccessorHalves(l, static_found.?.owner, property);
        const place_type = typeAt(l, target_node, b);
        const read = if (halves.get) try members.staticAccessorCall(l, .get, owner, property, &.{}, place_type, span, target_node, b) else l.undef(span);
        return m.finish(.{ .current = read, .write = .{ .static_accessor = .{ .owner = owner, .property = property, .node = target_node, .b = b } } }, &none);
    }
    if (is_prop and gt.staticMemberOf(l.g, target_node, false) != null) return null;

    var statements: StmtList = .empty;
    const receiver = if (is_prop) target_node.data.prop_access.expr else target_node.data.elem_access.expr;
    const target = try hoisted(l, receiver, 0, plain, b, &statements);
    const place_type = typeAt(l, target_node, b);
    var place: Place = undefined;
    if (!is_prop) {
        const index_node = target_node.data.elem_access.index;
        const literal_key = gt.elementStaticKey(l.g, index_node);
        const is_object = target.getType().* == .object;
        const place_owner = if (literal_key != null and is_object) members.accessorOwner(l, receiver, literal_key.?, b) else null;
        if (place_owner != null) {
            place = try members.accessorPlace(l, place_owner.?, target, literal_key.?, members.hasAccessorHalf(l, receiver, literal_key.?, .get, b), place_type, span, target_node);
        } else if (literal_key != null and is_object and members.declaresMember(l, target.getType(), literal_key.?)) {
            const slot = try members.slotOf(l, target, literal_key.?, target_node);
            place = .{
                .current = l.ex(.field_access, .{ .type = place_type, .span = span, .target = target, .field = literal_key.?, .slot = slot }),
                .write = .{ .field = .{ .target = target, .field = literal_key.?, .slot = slot } },
            };
        } else {
            const index = try hoisted(l, index_node, 1, plain, b, &statements);
            place = .{ .current = l.ex(.index_access, .{ .type = place_type, .span = span, .target = target, .index = index }), .write = .{ .index = .{ .target = target, .index = index } } };
        }
        return m.finish(place, &statements);
    }

    const name_node = target_node.data.prop_access.name;
    const name = members.propertyText(target_node);
    const is_private = name_node.data == .private_name;
    if (is_private and members.privateUse(l, name_node) == null) return l.internal(target_node, "STA4060", l.fmt("no private '{s}' the gate accepted", .{name}));
    if (members.privateWriteIsAccessor(l, target_node) or members.accessorOwner(l, receiver, name, b) != null) {
        const write_priv = if (is_private) members.privateUse(l, name_node) else null;
        var lexical_owner: ?[]const u8 = null;
        if (write_priv) |p| {
            lexical_owner = members.mangleClassName(l, p.owner, receiver, b) orelse
                return l.internal(target_node, "STA4067", l.fmt("private '{s}' names no descriptor the lowering can reach", .{name}));
        }
        const field = if (write_priv) |p| p.property else name;
        const owner = lexical_owner orelse members.accessorOwner(l, receiver, field, b) orelse "";
        const write_has_get = if (write_priv) |p| members.privateAccessorHalves(p.owner, name).get else members.hasAccessorHalf(l, receiver, field, .get, b);
        place = try members.accessorPlace(l, owner, target, field, write_has_get, place_type, span, target_node);
    } else if (members.targetIsDynamic(l, receiver, b) or gt.isFunctionValueMember(l.g, receiver, name) or gt.isUndeclaredMemberRead(l.g, target_node) or
        (target.getType().* == .array and c.eql(name, "length")))
    {
        place = .{
            .current = if (target.getType().* == .array) patterns.lengthRead(l, target, span) else l.ex(.dyn_field_access, .{ .type = c.hUnknown(false), .span = span, .target = target, .field = name }),
            .write = .{ .dyn = .{ .target = target, .field = name } },
        };
    } else {
        const write_field_priv = if (is_private) members.privateUse(l, name_node) else null;
        const field = if (write_field_priv) |p| p.property else name;
        const slot = try members.slotOf(l, target, field, target_node);
        place = .{
            .current = l.ex(.field_access, .{ .type = place_type, .span = span, .target = target, .field = field, .slot = slot }),
            .write = .{ .field = .{ .target = target, .field = field, .slot = slot } },
        };
    }
    return m.finish(place, &statements);
}

pub fn lowerIndexAccess(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const x = node.data.elem_access;
    const target = try lowerExpression(l, x.expr, b);
    const index = try lowerExpression(l, x.index, b);
    return l.ex(.index_access, .{ .type = typeAt(l, node, b), .span = l.span(node), .target = target, .index = index });
}

const LoopCapture = struct { l: *Lower, loop: *Node };

/// A `let`/`const` of `loop` named inside a closure; a `var` is one binding for every iteration.
fn loopBindingStep(s: LoopCapture, node: *Node) ast_walk.Step {
    if (node.data != .identifier) return .descend;
    const symbol = s.l.g.symbolAt(node) orelse return .skip;
    const decl = symbol.value_decl orelse return .skip;
    const is_var = decl.data == .var_decl and decl.parent != null and decl.parent.?.data == .var_list and decl.parent.?.data.var_list.kind == .@"var";
    return if (c.captures.loopScopeOf(decl) == s.loop and !is_var) .match else .skip;
}

fn closureStep(s: LoopCapture, node: *Node) ast_walk.Step {
    if (!c.isFunctionLike(node)) return .descend;
    return if (ast_walk.contains(node, s, loopBindingStep)) .match else .skip;
}

pub fn loopNeedsPerIterationEnv(l: *Lower, loop: *Node) bool {
    return ast_walk.contains(loop, LoopCapture{ .l = l, .loop = loop }, closureStep);
}

pub fn lowerUpdateExpression(l: *Lower, node: *Node, b: *Scope) E!?Expression {
    const parent = node.parent.?;
    if (parent.data == .expr_stmt or (parent.data == .for_stmt and parent.data.for_stmt.update == node)) return null;
    const update = updateOperator(node);
    const plain = isPlainAssign(node);
    const kinds = assignOperatorKinds(node);
    if (update == null and kinds.compound == null and kinds.logical == null and !plain) return null;
    const target_node: *Node = if (update) |u| u.operand else if (node.data == .binary) node.data.binary.left else return null;
    const target = try lowerUpdatePlace(l, target_node, b);
    const span = l.span(node);
    if (update) |u| {
        return l.ex(.update, .{ .type = c.H_NUMBER, .span = span, .operator = if (u.operator == .@"+") .@"++" else .@"--", .prefix = node.data == .prefix, .target = target });
    }
    if (node.data != .binary) return null;
    const assign_op: N.UpdateOperator = if (kinds.compound) |x| std.meta.stringToEnum(N.UpdateOperator, @tagName(x)).? else if (kinds.logical) |x| std.meta.stringToEnum(N.UpdateOperator, @tagName(x)).? else .@"=";
    const raw = try lowerExpression(l, node.data.binary.right, b);
    const value = if (plain and node.data.binary.left.data == .identifier) withDisplayName(l, raw, node.data.binary.left.data.identifier) else raw;
    return l.ex(.update, .{ .type = typeAt(l, node, b), .span = span, .operator = assign_op, .prefix = true, .target = target, .value = value });
}

fn lowerUpdatePlace(l: *Lower, node: *Node, b: *Scope) E!N.UpdatePlace {
    if (try accessorUpdateTarget(l, node, b)) |accessor| return .{ .accessor_place = accessor };
    const lowered = try lowerExpression(l, node, b);
    var e = lowered;
    if (lowered == .boundary_check) switch (lowered.boundary_check.value) {
        .identifier, .index_access, .field_access, .dyn_field_access => e = lowered.boundary_check.value,
        else => {},
    };
    return switch (e) {
        .array_length => |x| .{ .dyn_field_access = l.create(N.DynFieldAccess{ .type = c.hUnknown(false), .span = x.span, .target = x.operand, .field = "length" }) },
        else => N.UpdatePlace.of(e) orelse l.internal(node, "STA4033", "update target must be a variable or member"),
    };
}

fn accessorUpdateTarget(l: *Lower, node: *Node, b: *Scope) E!?*const N.AccessorPlace {
    const property: []const u8, const receiver: *Node = switch (node.data) {
        .prop_access => |x| .{ members.propertyText(node), x.expr },
        .elem_access => |x| .{ gt.elementStaticKey(l.g, x.index) orelse return null, x.expr },
        else => return null,
    };
    const owner = members.accessorOwner(l, receiver, property, b) orelse return null;
    const target = try lowerExpression(l, receiver, b);
    const t = target.getType();
    if (t.* != .object) return null;
    const get_slot = members.methodSlot(t, l.accessorName(.get, property));
    const set_slot = members.methodSlot(t, l.accessorName(.set, property));
    if (get_slot < 0 and set_slot < 0) return null;
    const has_get = members.hasAccessorHalf(l, receiver, property, .get, b);
    return l.create(N.AccessorPlace{
        .type = typeAt(l, node, b),
        .span = l.span(node),
        .target = target,
        .owner = owner,
        .property = property,
        .get_slot = get_slot,
        .set_slot = set_slot,
        .dispatch = members.dispatchOf(l, t.object.name, l.accessorName(.get, property)),
        .has_get = has_get,
    });
}

pub fn bindPatternNames(l: *Lower, name: *Node, b: *Scope) void {
    switch (name.data) {
        .identifier => |x| _ = b.declare(x, typeAt(l, name, b)),
        .object_pattern => |x| for (x.elems) |el| bindPatternNames(l, el.data.binding_elem.name, b),
        .array_pattern => |x| for (x.elems) |el| {
            if (el.data != .omitted_expr) bindPatternNames(l, el.data.binding_elem.name, b);
        },
        else => {},
    }
}

pub const SameValue = struct {
    value: Expression,
    pub fn make(s: @This(), _: Expression) E!Expression {
        return s.value;
    }
};

pub fn lowerForIn(l: *Lower, node: *Node, b: *Scope, label: ?[]const u8) E!Statement {
    const f = node.data.for_in;
    const span = l.span(node);
    const source = try lowerExpression(l, f.expr, b);
    const keys_name = l.nextBindTemp();
    const index_name = l.nextBindTemp();
    const keys_type = l.hArray(c.H_STRING);
    const inner = b.child();
    inner.set(keys_name, keys_type);
    inner.set(index_name, c.H_NUMBER);
    var hir_binding: []const u8 = undefined;
    var decl_kind: N.DeclKind = .let;
    var existing: ?*Node = null;
    if (f.init.data == .var_list) {
        const list = f.init.data.var_list;
        if (list.decls.len == 0 or list.decls[0].data.var_decl.name.data != .identifier) return l.internal(f.init, "STA4031", "for-in binding must be a name");
        const decl = list.decls[0];
        decl_kind = if (list.kind == .@"const") .@"const" else .let;
        hir_binding = inner.declare(decl.data.var_decl.name.data.identifier, c.H_STRING);
        l.setHirName(decl, hir_binding);
    } else if (f.init.data == .identifier) {
        existing = f.init;
        hir_binding = l.nextBindTemp();
        decl_kind = .@"const";
        inner.set(hir_binding, c.H_STRING);
    } else return l.internal(f.init, "STA4031", "for-in binding must be a name");
    const body = try lowerBody(l, f.body, inner);
    const keys_id = l.ident(keys_type, span, keys_name);
    const index_id = l.ident(c.H_NUMBER, span, index_name);
    const keys_decl = l.st(.declaration, .{ .type = keys_type, .span = span, .name = keys_name, .decl_kind = .@"const", .value = l.ex(.object_static, .{ .type = keys_type, .span = span, .method = .forInKeys, .args = l.dupe(Expression, &.{source}) }) });
    const index_decl = l.st(.declaration, .{ .type = c.H_NUMBER, .span = span, .name = index_name, .decl_kind = .let, .value = l.number(span, 0) });
    const length = l.ex(.array_length, .{ .type = c.H_NUMBER, .span = span, .operand = keys_id });
    const cond = l.ex(.binary_op, .{ .type = c.H_BOOLEAN, .span = span, .operator = .@"<", .left = index_id, .right = length });
    const next = l.ex(.binary_op, .{ .type = c.H_NUMBER, .span = span, .operator = .@"+", .left = index_id, .right = l.number(span, 1) });
    const inc = l.st(.assignment, .{ .type = c.H_NUMBER, .span = span, .target = index_name, .value = next });
    const key_read = l.ex(.index_access, .{ .type = c.H_STRING, .span = span, .target = keys_id, .index = index_id });
    var loop_statements: StmtList = .empty;
    l.push(&loop_statements, l.st(.declaration, .{ .type = c.H_STRING, .span = span, .name = hir_binding, .decl_kind = decl_kind, .value = key_read }));
    if (existing) |target| {
        const assignment = try identifierAssignment(l, target, SameValue{ .value = l.ident(c.H_STRING, span, hir_binding) }, inner);
        l.push(&loop_statements, assignmentStatement(l, assignment, span));
    }
    loop_statements.appendSlice(l.a, body.statements) catch c.oom();
    const loop = l.st(.for_statement, .{ .type = c.H_UNDEFINED, .span = span, .init = index_decl, .condition = cond, .update = inc, .body = l.block(span, loop_statements.items), .label = label, .per_iteration_env = if (loopNeedsPerIterationEnv(l, node)) true else null });
    return l.st(.block, .{ .type = c.H_UNDEFINED, .span = span, .statements = l.dupe(Statement, &.{ keys_decl, loop }) });
}

pub fn lowerBody(l: *Lower, node: *Node, b: *Scope) E!*const Block {
    if (node.data == .block) return lowerBlock(l, node, b.child());
    const single = try statements_mod.lowerStatement(l, node, b, null);
    return l.block(l.span(node), l.dupe(Statement, &.{single}));
}

pub fn lowerBlock(l: *Lower, node: *Node, scope: *Scope) E!*const Block {
    const stmts = node.data.block.stmts;
    hoist.hoistFunctionDeclarations(l, stmts, scope);
    var out: StmtList = .empty;
    for (stmts) |child| l.push(&out, try statements_mod.lowerStatement(l, child, scope, null));
    return l.block(l.span(node), out.items);
}
