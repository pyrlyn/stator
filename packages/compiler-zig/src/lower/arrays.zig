//! Array literals and the spread lists calls share with them.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Scope = c.Scope;
const Expression = c.Expression;
const HType = c.HType;
const Span = c.Span;
const E = c.E;
const H = c.H;
const N = c.N;
const gt = c.gt;
const expressions = @import("expressions.zig");
const calls = @import("calls.zig");

pub const Segment = union(enum) {
    elems: *c.ExprList,
    spread: Expression,
};

pub const Segments = std.ArrayList(Segment);

fn arrayConcatExpr(l: *Lower, target: Expression, other: Expression, span: Span) Expression {
    const t = if (N.ARRAY_OPS.get(.concat).result == .self) target.getType() else c.hUnknown(false);
    return l.ex(.array_op, .{ .type = t, .span = span, .op = .concat, .target = target, .args = l.dupe(Expression, &.{other}), .spread = true });
}

fn emptyArrayLiteral(l: *Lower, t: *const HType, span: Span) Expression {
    return l.ex(.array_literal, .{ .type = t, .span = span, .elements = &.{} });
}

fn spreadOperand(l: *Lower, operand: Expression, span: Span) Expression {
    if (operand.getType().* == .array) return operand;
    return calls.globalCallNode(l, .@"...", l.dupe(Expression, &.{operand}), l.hArray(c.hUnknown(false)), span);
}

pub fn foldSpreadList(l: *Lower, segments: []const Segment, list_type: *const HType, span: Span) Expression {
    const empty_type = if (list_type.* == .array) list_type else l.hArray(c.hUnknown(false));
    var result: ?Expression = null;
    for (segments, 0..) |segment, index| switch (segment) {
        .elems => |list| {
            const run = l.ex(.array_literal, .{ .type = list_type, .span = span, .elements = list.items });
            result = if (result) |r| arrayConcatExpr(l, r, run, span) else run;
        },
        .spread => |spread| {
            const piece = spreadOperand(l, spread, span);
            if (result) |r| {
                result = arrayConcatExpr(l, r, piece, span);
            } else if (H.hTypeEquals(piece.getType(), empty_type)) {
                result = if (index + 1 < segments.len) piece else arrayConcatExpr(l, piece, emptyArrayLiteral(l, empty_type, span), span);
            } else {
                result = arrayConcatExpr(l, emptyArrayLiteral(l, empty_type, span), piece, span);
            }
        },
    };
    return result orelse emptyArrayLiteral(l, empty_type, span);
}

/// `lower` takes one element node, unwrapped from its spread.
pub fn lowerSpreadSegments(l: *Lower, elements: []const *Node, lower: anytype) E!Segments {
    var segments: Segments = .empty;
    for (elements) |element| {
        const is_spread = element.data == .spread_elem;
        const lowered = try lower.lower(if (is_spread) element.data.spread_elem.expr else element);
        if (is_spread) {
            l.push(&segments, Segment{ .spread = lowered });
            continue;
        }
        if (segments.items.len > 0 and segments.items[segments.items.len - 1] == .elems) {
            l.push(segments.items[segments.items.len - 1].elems, lowered);
        } else {
            const list = l.create(c.ExprList.empty);
            l.push(list, lowered);
            l.push(&segments, Segment{ .elems = list });
        }
    }
    return segments;
}

pub fn emptyArrayContextType(l: *Lower, node: *Node, b: ?*Scope) ?*const HType {
    if (node.data.array_lit.elems.len != 0) return null;
    const contextual = gt.layoutContextualType(l.g, node) orelse return null;
    const declared = l.toH(contextual);
    const t = if (b) |scope| expressions.ground(l, declared, scope) else declared;
    return if (t.* == .array and !H.hasTypeParam(t)) t else null;
}

const PlainLower = struct {
    l: *Lower,
    b: *Scope,

    pub fn lower(s: PlainLower, element: *Node) E!Expression {
        return expressions.lowerExpression(s.l, element, s.b);
    }
};

pub fn lowerArrayLiteralExpression(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const span = l.span(node);
    const elements = node.data.array_lit.elems;
    const literal_type = emptyArrayContextType(l, node, b) orelse expressions.typeAt(l, node, b);
    var has_spread = false;
    for (elements) |element| has_spread = has_spread or element.data == .spread_elem;
    if (!has_spread) {
        const out = l.a.alloc(Expression, elements.len) catch c.oom();
        for (elements, out) |element, *slot| slot.* = try expressions.lowerExpression(l, element, b);
        return l.ex(.array_literal, .{ .type = literal_type, .span = span, .elements = out });
    }
    const segments = try lowerSpreadSegments(l, elements, PlainLower{ .l = l, .b = b });
    return foldSpreadList(l, segments.items, literal_type, span);
}
