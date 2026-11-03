//! Hand-built HIR for unit tests. Every node sits at one span, because a test that cares where a
//! node is builds it by hand.

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("nodes.zig");
const types = @import("types.zig");
const Expression = nodes.Expression;
const Statement = nodes.Statement;

pub const span: nodes.Span = .{ .start = 0, .length = 0, .line = 1 };

pub fn node(arena: Allocator, value: anytype) Allocator.Error!*const @TypeOf(value) {
    const out = try arena.create(@TypeOf(value));
    out.* = value;
    return out;
}

/// A number, string or boolean literal, by the type of `value`.
pub fn literal(arena: Allocator, value: anytype) Allocator.Error!Expression {
    const kind = switch (@TypeOf(value)) {
        f64, comptime_float, comptime_int => "number",
        bool => "boolean",
        else => "string",
    };
    const Payload = @typeInfo(@FieldType(Expression, kind ++ "_literal")).pointer.child;
    return @unionInit(Expression, kind ++ "_literal", try node(arena, Payload{ .type = @field(types.leaf, kind), .span = span, .value = value }));
}

pub fn identifier(arena: Allocator, name: []const u8, t: *const types.HType) Allocator.Error!Expression {
    return .{ .identifier = try node(arena, nodes.Identifier{ .type = t, .span = span, .name = name }) };
}

pub fn expressionStatement(arena: Allocator, expr: Expression) Allocator.Error!Statement {
    return .{ .expression_statement = try node(arena, nodes.ExpressionStatement{ .type = expr.getType(), .span = span, .expression = expr }) };
}

pub fn declaration(arena: Allocator, name: []const u8, t: *const types.HType, value: ?Expression) Allocator.Error!Statement {
    return .{ .declaration = try node(arena, nodes.Declaration{ .type = t, .span = span, .name = name, .decl_kind = .let, .value = value }) };
}

pub fn block(arena: Allocator, statements: []const Statement) Allocator.Error!*const nodes.Block {
    return node(arena, nodes.Block{ .type = types.H_UNDEFINED, .span = span, .statements = statements });
}

pub fn moduleOf(arena: Allocator, statements: []const Statement) Allocator.Error!*const nodes.Module {
    return node(arena, nodes.Module{
        .type = types.H_UNDEFINED,
        .span = span,
        .file_name = "test.ts",
        .statements = statements,
        .is_async = false,
        .env_vars = &.{},
    });
}

/// A synchronous, typed function that captures nothing.
pub fn function(arena: Allocator, t: *const types.HType, params: []const nodes.Parameter, statements: []const Statement) Allocator.Error!*const nodes.FunctionExpr {
    return node(arena, nodes.FunctionExpr{
        .type = t,
        .span = span,
        .params = params,
        .body = try block(arena, statements),
        .env_vars = &.{},
        .captures = &.{},
        .needs_env = false,
        .is_async = false,
        .is_generator = false,
        .provenance = .typed,
    });
}
