//! Const-folding: compute at compile time what the program cannot observe being computed at run
//! time. `packages/compiler/src/passes/constfold.ts` keeps the reasoning.
//!
//! An operation folds only when every operand is already a literal node, never "provably
//! constant". A literal is never Unknown, so no fold can elide a boundary check, and a literal
//! calls and reads nothing, so deleting one deletes no behaviour.
//!
//! The TypeScript pass evaluates with the language it runs on. There is no such language here, so
//! `jsvalue.zig` spells out what JavaScript does, and `zigdiff` holds the two to the same bytes.

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("../hir/nodes.zig");
const types = @import("../hir/types.zig");
const js = @import("jsvalue.zig");
const rewrite = @import("rewrite.zig");
const Error = rewrite.Error;
const Expression = nodes.Expression;
const HType = types.HType;
const Module = nodes.Module;
const Span = nodes.Span;

pub fn constFold(arena: Allocator, module: *const Module) Error!*const Module {
    var fold_context: Fold = .{ .arena = arena };
    return rewrite.rewriteModule(module, rewrite.visiting(Fold, arena, &fold_context));
}

/// The whole domain this pass evaluates over. It holds no object, so no operator below can reach a
/// `valueOf` the program would have observed.
const Literal = union(enum) {
    number: f64,
    string: []const u8,
    boolean: bool,
    null,
    undefined,
};

fn literalValue(expr: Expression) ?Literal {
    return switch (expr) {
        .number_literal => |node| .{ .number = node.value },
        .string_literal => |node| .{ .string = node.value },
        .boolean_literal => |node| .{ .boolean = node.value },
        .null_literal => .null,
        .undefined_literal => .undefined,
        else => null,
    };
}

/// A literal node, or null when the HIR has none for it. A mismatch with the replaced node's type
/// refuses the fold, which stops it changing a type underneath the verifier.
fn literalNode(arena: Allocator, value: Literal, expected: *const HType, span: Span) Allocator.Error!?Expression {
    switch (value) {
        inline .number, .string, .boolean => |payload, tag| {
            const t = @field(types.leaf, @tagName(tag));
            if (!types.hTypeEquals(expected, t)) return null;
            const field = @tagName(tag) ++ "_literal";
            const node = try arena.create(@typeInfo(@FieldType(Expression, field)).pointer.child);
            node.* = .{ .type = t, .span = span, .value = payload };
            return @unionInit(Expression, field, node);
        },
        .null, .undefined => return null,
    }
}

fn toNumber(value: Literal) f64 {
    return switch (value) {
        .number => |number| number,
        .string => |string| js.stringToNumber(string),
        .boolean => |boolean| if (boolean) 1 else 0,
        .null => 0,
        .undefined => std.math.nan(f64),
    };
}

fn toBoolean(value: Literal) bool {
    return switch (value) {
        .number => |number| number != 0 and !std.math.isNan(number),
        .string => |string| string.len != 0,
        .boolean => |boolean| boolean,
        .null, .undefined => false,
    };
}

fn toString(arena: Allocator, value: Literal) Allocator.Error![]const u8 {
    return switch (value) {
        .number => |number| js.numberToString(arena, number),
        .string => |string| string,
        .boolean => |boolean| if (boolean) "true" else "false",
        .null => "null",
        .undefined => "undefined",
    };
}

fn typeOf(value: Literal) []const u8 {
    return switch (value) {
        .number => "number",
        .string => "string",
        .boolean => "boolean",
        .null => "object",
        .undefined => "undefined",
    };
}

fn strictEquals(left: Literal, right: Literal) bool {
    return switch (left) {
        .number => |number| right == .number and number == right.number,
        .string => |string| right == .string and std.mem.eql(u8, string, right.string),
        .boolean => |boolean| right == .boolean and boolean == right.boolean,
        .null => right == .null,
        .undefined => right == .undefined,
    };
}

/// With no object operand the coercion table has no observable steps; only null and undefined
/// stand apart from the numeric comparison everything else reduces to.
fn looseEquals(left: Literal, right: Literal) bool {
    if (std.meta.activeTag(left) == std.meta.activeTag(right)) return strictEquals(left, right);
    const left_nullish = left == .null or left == .undefined;
    const right_nullish = right == .null or right == .undefined;
    if (left_nullish or right_nullish) return left_nullish and right_nullish;
    return toNumber(left) == toNumber(right);
}

/// Two strings compare by code unit; any NaN operand makes all four operators false, which the
/// IEEE comparison gives for free.
fn relational(comptime op: std.math.CompareOperator, left: Literal, right: Literal) bool {
    if (left == .string and right == .string) {
        return js.compareStrings(left.string, right.string).compare(op);
    }
    return std.math.compare(toNumber(left), op, toNumber(right));
}

fn remainder(left: f64, right: f64) f64 {
    // `@rem` promises nothing for a zero divisor.
    if (right == 0) return std.math.nan(f64);
    return @rem(left, right);
}

fn shift(value: f64) u5 {
    return @truncate(js.toUint32(value));
}

/// One arm per operator, kept as one table: `+` is the only one that is not numeric, which is the
/// thing about this list a reader has to notice.
fn applyBinary(arena: Allocator, operator: nodes.BinaryOperator, left: Literal, right: Literal) Allocator.Error!Literal {
    const l = toNumber(left);
    const r = toNumber(right);
    return switch (operator) {
        .@"+" => if (left == .string or right == .string)
            .{ .string = try js.concat(arena, try toString(arena, left), try toString(arena, right)) }
        else
            .{ .number = l + r },
        .@"-" => .{ .number = l - r },
        .@"*" => .{ .number = l * r },
        .@"/" => .{ .number = l / r },
        .@"%" => .{ .number = remainder(l, r) },
        .@"<" => .{ .boolean = relational(.lt, left, right) },
        .@">" => .{ .boolean = relational(.gt, left, right) },
        .@"<=" => .{ .boolean = relational(.lte, left, right) },
        .@">=" => .{ .boolean = relational(.gte, left, right) },
        .@"===" => .{ .boolean = strictEquals(left, right) },
        .@"!==" => .{ .boolean = !strictEquals(left, right) },
        .@"==" => .{ .boolean = looseEquals(left, right) },
        .@"!=" => .{ .boolean = !looseEquals(left, right) },
        .@"&" => int32(js.toInt32(l) & js.toInt32(r)),
        .@"|" => int32(js.toInt32(l) | js.toInt32(r)),
        .@"^" => int32(js.toInt32(l) ^ js.toInt32(r)),
        .@"<<" => int32(js.toInt32(l) << shift(r)),
        .@">>" => int32(js.toInt32(l) >> shift(r)),
        // The one bitwise result above int32 range, which is why bitwise results are `number`.
        .@">>>" => .{ .number = @floatFromInt(js.toUint32(l) >> shift(r)) },
        .@"**" => .{ .number = js.exponentiate(l, r) },
        .@"," => right,
        // `in` does not answer for two literals, it throws: the right operand must be an object.
        // Declining leaves that to the runtime (plan-notes 220).
        .in => .undefined,
    };
}

fn int32(value: i32) Literal {
    return .{ .number = @floatFromInt(value) };
}

fn applyUnary(operator: nodes.UnaryOperator, operand: Literal) Literal {
    return switch (operator) {
        // The only way to reach `-0` from `+0`, so it is computed, never `0 - x`.
        .@"-" => .{ .number = -toNumber(operand) },
        .@"+" => .{ .number = toNumber(operand) },
        .@"!" => .{ .boolean = !toBoolean(operand) },
        .@"~" => int32(~js.toInt32(toNumber(operand))),
        .void => .undefined,
    };
}

const Fold = struct {
    arena: Allocator,

    fn replace(self: *Fold, expr: Expression, value: Literal, expected: *const HType) Allocator.Error!Expression {
        return (try literalNode(self.arena, value, expected, expr.getSpan())) orelse expr;
    }

    /// The arms are the specification of this pass: each names one operation that may fold and
    /// the condition under which that is not observable.
    pub fn expression(self: *Fold, expr: Expression) Error!Expression {
        const arena = self.arena;
        switch (expr) {
            .binary_op => |node| {
                const left = literalValue(node.left) orelse return expr;
                const right = literalValue(node.right) orelse return expr;
                return self.replace(expr, try applyBinary(arena, node.operator, left, right), node.type);
            },
            .unary_op => |node| {
                const operand = literalValue(node.operand) orelse return expr;
                return self.replace(expr, applyUnary(node.operator, operand), node.type);
            },
            // Decidable here because the operand is a literal node, not a value whose static type
            // happens to say `number` over an unchecked unknown.
            .typeof => |node| {
                const operand = literalValue(node.operand) orelse return expr;
                return self.replace(expr, .{ .string = typeOf(operand) }, node.type);
            },
            // The left operand alone decides which side survives, so this fold may delete an
            // effect, rightly: `false && f()` never calls `f` at run time either.
            .logical_op => |node| {
                const left = literalValue(node.left) orelse return expr;
                const takes_right = switch (node.operator) {
                    .@"&&" => toBoolean(left),
                    .@"||" => !toBoolean(left),
                    .@"??" => left == .null or left == .undefined,
                };
                const chosen = if (takes_right) node.right else node.left;
                // The node can be wider than the surviving branch, and replacing it would narrow
                // the tree silently.
                return if (types.hTypeEquals(chosen.getType(), node.type)) chosen else expr;
            },
            .template_literal => |node| {
                for (node.expressions) |hole| {
                    if (literalValue(hole) == null) return expr;
                }
                var text: []const u8 = if (node.quasis.len > 0) node.quasis[0] else "";
                for (node.expressions, 0..) |hole, index| {
                    text = try js.concat(arena, text, try toString(arena, literalValue(hole).?));
                    if (index + 1 < node.quasis.len) text = try js.concat(arena, text, node.quasis[index + 1]);
                }
                return self.replace(expr, .{ .string = text }, node.type);
            },
            .string_length => |node| {
                const operand = literalValue(node.operand) orelse return expr;
                if (operand != .string) return expr;
                return self.replace(expr, .{ .number = @floatFromInt(js.utf16Length(operand.string)) }, node.type);
            },
            // Only when every element is a literal: `[f()].length` is 1, and folding it anyway
            // would delete the call.
            .array_length => |node| {
                if (node.operand != .array_literal) return expr;
                const elements = node.operand.array_literal.elements;
                for (elements) |element| {
                    if (literalValue(element) == null) return expr;
                }
                return self.replace(expr, .{ .number = @floatFromInt(elements.len) }, node.type);
            },
            else => return expr,
        }
    }
};
