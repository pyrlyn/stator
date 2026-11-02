//! Operator and check tables for the C emitter. Mirrors `packages/compiler/src/codegen/tables.ts`,
//! which keeps why each operator spells the way it does.

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("../hir/nodes.zig");
const BinaryOperator = nodes.BinaryOperator;
const UnaryOperator = nodes.UnaryOperator;

pub fn binaryEmitter(arena: Allocator, operator: BinaryOperator, l: []const u8, r: []const u8) Allocator.Error![]const u8 {
    const f = std.fmt.allocPrint;
    return switch (operator) {
        .@"+" => f(arena, "jsrt_op_add({s}, {s})", .{ l, r }),
        .@"-" => f(arena, "jsrt_number(jsrt_to_number({s}) - jsrt_to_number({s}))", .{ l, r }),
        .@"*" => f(arena, "jsrt_number(jsrt_to_number({s}) * jsrt_to_number({s}))", .{ l, r }),
        .@"/" => f(arena, "jsrt_number(jsrt_to_number({s}) / jsrt_to_number({s}))", .{ l, r }),
        .@"%" => f(arena, "jsrt_number(fmod(jsrt_to_number({s}), jsrt_to_number({s})))", .{ l, r }),
        .@"<" => f(arena, "jsrt_bool(jsrt_op_lt({s}, {s}))", .{ l, r }),
        .@">" => f(arena, "jsrt_bool(jsrt_op_gt({s}, {s}))", .{ l, r }),
        .@"<=" => f(arena, "jsrt_bool(jsrt_op_le({s}, {s}))", .{ l, r }),
        .@">=" => f(arena, "jsrt_bool(jsrt_op_ge({s}, {s}))", .{ l, r }),
        .@"===" => f(arena, "jsrt_bool(jsrt_strict_equals({s}, {s}))", .{ l, r }),
        .@"!==" => f(arena, "jsrt_bool(!jsrt_strict_equals({s}, {s}))", .{ l, r }),
        .@"==" => f(arena, "jsrt_bool(jsrt_loose_equals({s}, {s}))", .{ l, r }),
        .@"!=" => f(arena, "jsrt_bool(!jsrt_loose_equals({s}, {s}))", .{ l, r }),
        .@"&" => f(arena, "jsrt_op_bitand({s}, {s})", .{ l, r }),
        .@"|" => f(arena, "jsrt_op_bitor({s}, {s})", .{ l, r }),
        .@"^" => f(arena, "jsrt_op_bitxor({s}, {s})", .{ l, r }),
        .@"<<" => f(arena, "jsrt_op_shl({s}, {s})", .{ l, r }),
        .@">>" => f(arena, "jsrt_op_shr({s}, {s})", .{ l, r }),
        .@">>>" => f(arena, "jsrt_op_ushr({s}, {s})", .{ l, r }),
        .@"**" => f(arena, "jsrt_math_pow({s}, {s})", .{ l, r }),
        .@"," => r,
        .in => f(arena, "jsrt_bool(jsrt_in({s}, {s}))", .{ l, r }),
    };
}

pub fn unaryEmitter(arena: Allocator, operator: UnaryOperator, x: []const u8) Allocator.Error![]const u8 {
    const f = std.fmt.allocPrint;
    return switch (operator) {
        .@"-" => f(arena, "jsrt_number(-jsrt_to_number({s}))", .{x}),
        .@"+" => f(arena, "jsrt_number(jsrt_to_number({s}))", .{x}),
        .@"!" => f(arena, "jsrt_bool(!jsrt_truthy({s}))", .{x}),
        .@"~" => f(arena, "jsrt_op_bitnot({s})", .{x}),
        .void => f(arena, "({s}, JSRT_UNDEFINED)", .{x}),
    };
}

/// The operators that apply ToNumeric to both operands (§13.15.3 steps 3-4).
pub fn isNumericBinaryOperator(operator: BinaryOperator) bool {
    return switch (operator) {
        .@"-", .@"*", .@"/", .@"%", .@"**", .@"&", .@"|", .@"^", .@"<<", .@">>", .@">>>" => true,
        else => false,
    };
}

/// Deliberately partial: a kind the runtime cannot test in constant time has no entry, and the
/// gate refuses that narrowing, so null here is a gate/emitter disagreement.
pub fn checkFunction(kind: nodes.HType) ?[]const u8 {
    return switch (kind) {
        .number => "jsrt_check_number",
        .string => "jsrt_check_string",
        .boolean => "jsrt_check_boolean",
        .uint8array => "jsrt_check_uint8array",
        else => null,
    };
}

const testing = std.testing;

test "every binary operator spells its runtime call" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    try testing.expectEqualStrings("jsrt_op_add(a, b)", try binaryEmitter(arena, .@"+", "a", "b"));
    try testing.expectEqualStrings("jsrt_number(fmod(jsrt_to_number(a), jsrt_to_number(b)))", try binaryEmitter(arena, .@"%", "a", "b"));
    try testing.expectEqualStrings("jsrt_bool(!jsrt_loose_equals(a, b))", try binaryEmitter(arena, .@"!=", "a", "b"));
    try testing.expectEqualStrings("b", try binaryEmitter(arena, .@",", "a", "b"));
    try testing.expectEqualStrings("jsrt_bool(jsrt_in(a, b))", try binaryEmitter(arena, .in, "a", "b"));
    try testing.expectEqualStrings("(x, JSRT_UNDEFINED)", try unaryEmitter(arena, .void, "x"));
    try testing.expectEqualStrings("jsrt_number(-jsrt_to_number(x))", try unaryEmitter(arena, .@"-", "x"));
}

test "only the arithmetic and bitwise operators are numeric" {
    try testing.expect(isNumericBinaryOperator(.@"**"));
    try testing.expect(isNumericBinaryOperator(.@">>>"));
    try testing.expect(!isNumericBinaryOperator(.@"+"));
    try testing.expect(!isNumericBinaryOperator(.@"<"));
}
