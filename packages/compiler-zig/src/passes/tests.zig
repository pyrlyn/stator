//! Unit tests over hand-built HIR. The real proof is `packages/tests/zigdiff`, which holds these
//! passes to the TypeScript ones over the whole corpus; these pin what the corpus reaches rarely.

const std = @import("std");
const testing = std.testing;
const Allocator = std.mem.Allocator;
const nodes = @import("../hir/nodes.zig");
const types = @import("../hir/types.zig");
const verify = @import("../hir/verify.zig");
const root = @import("root.zig");
const Expression = nodes.Expression;
const Module = nodes.Module;
const Span = nodes.Span;
const Statement = nodes.Statement;

const sample = @import("../hir/sample.zig");
const span = sample.span;
const node = sample.node;
const literal = sample.literal;
const identifier = sample.identifier;
const expressionStatement = sample.expressionStatement;
const block = sample.block;
const moduleOf = sample.moduleOf;

fn binary(arena: Allocator, t: *const types.HType, operator: nodes.BinaryOperator, left: Expression, right: Expression) Allocator.Error!Expression {
    return .{ .binary_op = try node(arena, nodes.BinaryOp{ .type = t, .span = span, .operator = operator, .left = left, .right = right }) };
}

fn function(arena: Allocator, name: []const u8, params: []const nodes.Parameter, statements: []const Statement) Allocator.Error!Statement {
    return .{ .function_declaration = try node(arena, nodes.FunctionDeclaration{
        .type = types.H_UNDEFINED,
        .span = span,
        .name = name,
        .@"fn" = try sample.function(arena, types.H_UNDEFINED, params, statements),
    }) };
}

/// `do { body } while (false)`.
fn neverRepeating(arena: Allocator, body: []const Statement) Allocator.Error!Statement {
    const loop = nodes.DoWhileStatement{ .type = types.H_UNDEFINED, .span = span, .condition = try literal(arena, false), .body = try block(arena, body) };
    return .{ .do_while_statement = try node(arena, loop) };
}

fn returning(arena: Allocator, value: Expression) Allocator.Error!Statement {
    return .{ .return_statement = try node(arena, nodes.ReturnStatement{ .type = types.H_UNDEFINED, .span = span, .value = value }) };
}

fn foldOne(arena: Allocator, expr: Expression) !Expression {
    const module = try moduleOf(arena, &.{try expressionStatement(arena, expr)});
    const folded = try root.constfold.constFold(arena, module);
    return folded.statements[0].expression_statement.expression;
}

test "folding reproduces JavaScript's coercions" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();

    const sum = try foldOne(arena, try binary(arena, types.H_STRING, .@"+", try literal(arena, 1), try literal(arena, "a")));
    try testing.expectEqualStrings("1a", sum.string_literal.value);

    const shifted = try foldOne(arena, try binary(arena, types.H_NUMBER, .@">>>", try literal(arena, -1), try literal(arena, 0)));
    try testing.expectEqual(@as(f64, 4294967295), shifted.number_literal.value);

    const remainder = try foldOne(arena, try binary(arena, types.H_NUMBER, .@"%", try literal(arena, -4), try literal(arena, 2)));
    try testing.expect(std.math.signbit(remainder.number_literal.value));

    const compared = try foldOne(arena, try binary(arena, types.H_BOOLEAN, .@"==", try literal(arena, " 1 "), try literal(arena, 1)));
    try testing.expect(compared.boolean_literal.value);

    const negative = try foldOne(arena, .{ .unary_op = try node(arena, nodes.UnaryOp{
        .type = types.H_NUMBER,
        .span = span,
        .operator = .@"-",
        .operand = try literal(arena, 0),
    }) });
    try testing.expect(std.math.signbit(negative.number_literal.value));
}

test "a fold never changes the node's type" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const wide = try binary(arena, types.hUnknown(false), .@"+", try literal(arena, 1), try literal(arena, 2));
    try testing.expect(try foldOne(arena, wide) == .binary_op);
    const membership = try binary(arena, types.H_BOOLEAN, .in, try literal(arena, "length"), try literal(arena, "abc"));
    try testing.expect(try foldOne(arena, membership) == .binary_op);
}

test "an untouched tree comes back as the same pointer" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const module = try moduleOf(arena, &.{try expressionStatement(arena, try identifier(arena, "x", types.H_NUMBER))});
    try testing.expectEqual(module, try root.optimize(arena, module, &.{}));
}

test "inlining substitutes, folding computes, and the shake drops the function" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const params = [_]nodes.Parameter{.{ .name = "x", .type = types.H_NUMBER, .span = span }};
    const x = try identifier(arena, "x", types.H_NUMBER);
    const double = try function(arena, "double", &params, &.{
        try returning(arena, try binary(arena, types.H_NUMBER, .@"*", x, x)),
    });
    const call: Expression = .{ .call = try node(arena, nodes.CallExpr{
        .type = types.H_NUMBER,
        .span = span,
        .callee = try identifier(arena, "double", types.H_UNDEFINED),
        .args = &.{try literal(arena, 3)},
    }) };
    const module = try moduleOf(arena, &.{ double, try expressionStatement(arena, call) });
    const optimized = try root.optimize(arena, module, &.{});
    try testing.expectEqual(@as(usize, 1), optimized.statements.len);
    try testing.expectEqual(@as(f64, 9), optimized.statements[0].expression_statement.expression.number_literal.value);

    const kept = try root.optimize(arena, module, &.{"double"});
    try testing.expectEqual(@as(usize, 2), kept.statements.len);
}

test "a jump cuts what follows it, except a hoisted function" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const inner = try function(arena, "later", &.{}, &.{});
    const reference = try expressionStatement(arena, try identifier(arena, "later", types.H_UNDEFINED));
    const outer = try function(arena, "outer", &.{}, &.{
        reference,
        try returning(arena, try literal(arena, 1)),
        try expressionStatement(arena, try literal(arena, 2)),
        inner,
    });
    const module = try moduleOf(arena, &.{outer});
    const optimized = try root.optimize(arena, module, &.{"outer"});
    const body = optimized.statements[0].function_declaration.@"fn".body.statements;
    try testing.expectEqual(@as(usize, 3), body.len);
    try testing.expect(body[2] == .function_declaration);
}

test "a do-while with a false test keeps its body unless the body jumps" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const plain = try neverRepeating(arena, &.{});
    const jump: Statement = .{ .break_statement = try node(arena, nodes.BreakStatement{ .type = types.H_UNDEFINED, .span = span }) };
    const jumping = try neverRepeating(arena, &.{jump});
    const optimized = try root.optimize(arena, try moduleOf(arena, &.{ plain, jumping }), &.{});
    try testing.expect(optimized.statements[0] == .block);
    try testing.expect(optimized.statements[1] == .do_while_statement);
}

test "a for header that loses its update is refused" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    // Folds away entirely, which leaves the header without its update.
    const update = nodes.IfStatement{ .type = types.H_UNDEFINED, .span = span, .condition = try literal(arena, false), .consequent = try block(arena, &.{}) };
    const loop = nodes.ForStatement{ .type = types.H_UNDEFINED, .span = span, .update = .{ .if_statement = try node(arena, update) }, .body = try block(arena, &.{}) };
    try testing.expectError(error.ForHeaderStatementChanged, root.optimize(arena, try moduleOf(arena, &.{.{ .for_statement = try node(arena, loop) }}), &.{}));
}

test "a tree past the nesting limit is refused rather than walked" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    var deep = try literal(arena, 1);
    for (0..verify.MAX_NESTING + 1) |_| {
        deep = .{ .unary_op = try node(arena, nodes.UnaryOp{ .type = types.H_NUMBER, .span = span, .operator = .@"-", .operand = deep }) };
    }
    const statement: Statement = .{ .expression_statement = try node(arena, nodes.ExpressionStatement{ .type = types.H_NUMBER, .span = span, .expression = deep }) };
    const module = try node(arena, Module{ .type = types.H_UNDEFINED, .span = span, .file_name = "deep.ts", .statements = &.{statement}, .is_async = false, .env_vars = &.{} });
    try testing.expectError(error.NestedTooDeeply, root.optimize(arena, module, &.{}));
    const problems = try verify.verifyHir(arena, module);
    try testing.expectEqual(@as(usize, 1), problems.len);
    try testing.expectEqualStrings("STA4072", problems[0].code);
}
