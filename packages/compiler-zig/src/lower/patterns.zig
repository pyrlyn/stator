//! Destructuring in declarations and parameters.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Scope = c.Scope;
const Expression = c.Expression;
const Statement = c.Statement;
const StmtList = c.StmtList;
const HType = c.HType;
const Span = c.Span;
const E = c.E;
const H = c.H;
const gt = c.gt;
const N = c.N;
const boundary = @import("boundary.zig");
const expressions = @import("expressions.zig");
const lowerExpression = expressions.lowerExpression;
const members = @import("members.zig");

pub const Key = union(enum) { name: []const u8, index: u32 };

pub fn lengthRead(l: *Lower, operand: Expression, span: Span) Expression {
    return switch (operand.getType().*) {
        .array => l.ex(.array_length, .{ .type = c.H_NUMBER, .span = span, .operand = operand }),
        .@"fn" => l.ex(.function_length, .{ .type = c.H_NUMBER, .span = span, .operand = operand }),
        // A dynamic read lost the operand's static type; guessing "string" asserted on arrays, so
        // the name resolves at run time (lower/index.ts lengthRead).
        .unknown => l.ex(.dyn_field_access, .{ .type = c.hUnknown(false), .span = span, .target = operand, .field = "length" }),
        else => l.ex(.string_length, .{ .type = c.H_NUMBER, .span = span, .operand = operand }),
    };
}

pub fn lowerPatternRead(l: *Lower, target: Expression, key: Key, name: *Node, at: *Node, b: *Scope, override: ?*const HType) E!Expression {
    const span = l.span(at);
    const t = override orelse expressions.typeAt(l, name, b);
    const field = switch (key) {
        .index => |i| return l.ex(.index_access, .{ .type = t, .span = span, .target = target, .index = l.number(span, @floatFromInt(i)) }),
        .name => |x| x,
    };
    if (members.namespaceObjectField(l, target, field, b)) |member| return l.ident(member.type, span, member.name);
    const tt = target.getType();
    if (c.eql(field, "length") and (tt.* == .array or tt.* == .@"fn" or tt.* == .string)) return lengthRead(l, target, span);
    if (tt.* == .unknown) return l.ex(.dyn_field_access, .{ .type = c.hUnknown(false), .span = span, .target = target, .field = field });
    const slot = try members.slotOf(l, target, field, at);
    return l.ex(.field_access, .{ .type = t, .span = span, .target = target, .field = field, .slot = slot });
}

pub fn holdInTemp(l: *Lower, value: Expression, span: Span, b: *Scope, statements: *StmtList) Expression {
    const tmp = l.nextBindTemp();
    const t = value.getType();
    b.set(tmp, t);
    l.push(statements, l.st(.declaration, .{ .type = t, .span = span, .name = tmp, .decl_kind = .@"const", .value = value }));
    return l.ident(t, span, tmp);
}

fn finishPatternBind(l: *Lower, el: *Node, source: Expression, value: Expression, t: *const HType, decl_kind: N.DeclKind, b: *Scope, statements: *StmtList) E!void {
    const name = el.data.binding_elem.name;
    if (name.data != .identifier) {
        const parts = try lowerBindingPattern(l, name, source, decl_kind, el, b);
        statements.appendSlice(l.a, parts) catch c.oom();
        return;
    }
    const hir_name = b.declare(name.data.identifier, t);
    l.setHirName(el, hir_name);
    l.push(statements, l.st(.declaration, .{ .type = t, .span = l.span(el), .name = hir_name, .decl_kind = decl_kind, .value = value }));
}

fn bindPatternElement(l: *Lower, source: Expression, key: Key, el: *Node, decl_kind: N.DeclKind, b: *Scope, statements: *StmtList) E!void {
    const elem = el.data.binding_elem;
    const read = try lowerPatternRead(l, source, key, elem.name, el, b, null);
    var bound = read;
    if (elem.init) |init| {
        const fallback = try lowerExpression(l, init, b);
        const span = l.span(el);
        const held = holdInTemp(l, read, span, b, statements);
        const is_undef = l.ex(.binary_op, .{ .operator = .@"===", .type = c.H_BOOLEAN, .span = span, .left = held, .right = l.undef(span) });
        bound = l.ex(.conditional, .{ .type = fallback.getType(), .span = span, .condition = is_undef, .consequent = fallback, .alternate = held });
    }
    const t = expressions.typeAt(l, elem.name, b);
    try finishPatternBind(l, el, bound, boundary.maybeBoundary(l, bound, t, el, false), t, decl_kind, b, statements);
}

pub fn patternSource(l: *Lower, rhs: Expression, span: Span, b: *Scope, statements: *StmtList) Expression {
    if (rhs == .identifier) return rhs;
    return holdInTemp(l, rhs, span, b, statements);
}

pub fn lowerBindingPattern(l: *Lower, name: *Node, rhs: Expression, decl_kind: N.DeclKind, at: *Node, b: *Scope) E![]const Statement {
    var statements: StmtList = .empty;
    const source = patternSource(l, rhs, l.span(at), b, &statements);
    switch (name.data) {
        .object_pattern => |pattern| {
            var bound: c.OrderedNames = .empty;
            for (pattern.elems) |el| {
                if (el.data.binding_elem.dotdotdot) continue;
                if (c.gate.bindingElementKey(l.g, el)) |field| bound.put(l.a, field, {}) catch c.oom();
            }
            for (pattern.elems) |el| {
                if (el.data.binding_elem.dotdotdot) {
                    try bindObjectRest(l, source, &bound, el, decl_kind, b, &statements);
                    continue;
                }
                const field = c.gate.bindingElementKey(l.g, el) orelse
                    return l.notYet(el, "a computed key with a runtime name in a destructuring pattern is not yet supported");
                try bindPatternElement(l, source, .{ .name = field }, el, decl_kind, b, &statements);
            }
        },
        .array_pattern => |pattern| {
            var index: u32 = 0;
            for (pattern.elems) |el| {
                if (el.data == .omitted_expr) {
                    index += 1;
                    continue;
                }
                if (el.data == .binding_elem and el.data.binding_elem.dotdotdot) {
                    try bindArrayRest(l, source, index, el, decl_kind, b, &statements);
                    break;
                }
                try bindPatternElement(l, source, .{ .index = index }, el, decl_kind, b, &statements);
                index += 1;
            }
        },
        else => return l.internal(name, "STA4031", "expected a binding pattern"),
    }
    return statements.items;
}

fn bindArrayRest(l: *Lower, source: Expression, index: u32, el: *Node, decl_kind: N.DeclKind, b: *Scope, statements: *StmtList) E!void {
    const span = l.span(el);
    const name = el.data.binding_elem.name;
    const t = expressions.typeAt(l, if (name.data == .identifier) name else el, b);
    const sliced = l.ex(.array_op, .{ .op = .slice, .type = t, .span = span, .target = source, .args = l.dupe(Expression, &.{ l.number(span, @floatFromInt(index)), l.undef(span) }) });
    try finishPatternBind(l, el, sliced, sliced, t, decl_kind, b, statements);
}

fn bindObjectRest(l: *Lower, source: Expression, bound: *const c.OrderedNames, el: *Node, decl_kind: N.DeclKind, b: *Scope, statements: *StmtList) E!void {
    const span = l.span(el);
    const src = source.getType();
    if (src.* == .object and src.object.methods.len > 0) return l.notYet(el, "an object rest over a type with methods is not yet supported");
    var rest: Expression = undefined;
    switch (src.*) {
        .object => |o| {
            var fields: std.ArrayList(c.HField) = .empty;
            for (o.fields) |f| if (!bound.contains(f.name)) l.push(&fields, f);
            const t = l.hObject(gt.shapeName(l.g, fields.items, &.{}), fields.items, &.{}, &.{}, null);
            var entries: std.ArrayList(N.ObjectEntry) = .empty;
            for (fields.items) |f| {
                const read = try lowerPatternRead(l, source, .{ .name = f.name }, el.data.binding_elem.name, el, b, f.type);
                l.push(&entries, N.ObjectEntry{ .name = f.name, .value = read });
            }
            rest = l.ex(.object_literal, .{ .type = t, .span = span, .entries = entries.items, .methods = &.{}, .method_copies = &.{} });
        },
        .unknown => {
            const empty = l.ex(.dyn_object_literal, .{ .type = c.hUnknown(false), .span = span, .entries = &.{} });
            const assign = l.ex(.object_static, .{ .method = .assign, .type = c.hUnknown(false), .span = span, .args = l.dupe(Expression, &.{ empty, source }) });
            const held = holdInTemp(l, assign, span, b, statements);
            for (bound.keys()) |key| {
                const removal = l.ex(.delete_prop, .{ .type = c.H_BOOLEAN, .span = span, .target = held, .key = l.string(span, key) });
                l.push(statements, l.st(.expression_statement, .{ .type = c.H_BOOLEAN, .span = span, .expression = removal }));
            }
            rest = held;
        },
        else => return l.notYet(el, "an object rest over a value with no fixed layout is not yet supported"),
    }
    try finishPatternBind(l, el, rest, rest, rest.getType(), decl_kind, b, statements);
}
