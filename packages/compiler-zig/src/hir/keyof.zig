//! TypeScript's string-literal unions, which the HIR spells as Zig enums. Where the TypeScript
//! writes `keyof typeof TABLE` or `A | B`, these derive the enum the same way, so a name is spelled
//! once and the enum and its table cannot drift apart.
const std = @import("std");

/// `keyof typeof rows`: one tag per row, in row order.
pub fn Keys(comptime rows: anytype) type {
    @setEvalBranchQuota(100_000);
    return std.meta.FieldEnum(@TypeOf(rows));
}

/// The rows as an array indexed by `Keys(rows)`. A row leaves out only fields with a default, as a
/// struct literal would.
pub fn table(comptime Value: type, comptime rows: anytype) std.EnumArray(Keys(rows), Value) {
    const Key = Keys(rows);
    @setEvalBranchQuota(100_000);
    var out: std.EnumArray(Key, Value) = undefined;
    inline for (comptime std.meta.fieldNames(Key)) |name| {
        out.set(@field(Key, name), row(Value, @field(rows, name)));
    }
    return out;
}

fn row(comptime Value: type, comptime given: anytype) Value {
    const Given = @TypeOf(given);
    if (Given == Value or @typeInfo(Value) != .@"struct") return given;
    inline for (comptime std.meta.fieldNames(Given)) |name| {
        if (!@hasField(Value, name)) @compileError("no field '" ++ name ++ "' in " ++ @typeName(Value));
    }
    const info = @typeInfo(Value).@"struct";
    var out: Value = undefined;
    inline for (info.field_names, info.field_types, info.field_attrs) |name, T, attr| {
        @field(out, name) = if (@hasField(Given, name))
            @field(given, name)
        else
            attr.defaultValue(T) orelse @compileError("missing field '" ++ name ++ "' of " ++ @typeName(Value));
    }
    return out;
}

/// `A | B | ...` over enums: every tag of each part, in order. A tag in two parts is a compile error.
pub fn Union(comptime parts: []const type) type {
    comptime var names: []const [:0]const u8 = &.{};
    inline for (parts) |Part| names = names ++ std.meta.fieldNames(Part);
    @setEvalBranchQuota(100_000);
    const Int = std.math.IntFittingRange(0, names.len - 1);
    return @Enum(Int, .exhaustive, names, &std.simd.iota(Int, names.len));
}

test "a table and its keys follow the rows" {
    const Info = struct { arity: u8, throws: bool = false };
    const rows = .{ .at = .{ .arity = 1 }, .@"union" = .{ .arity = 2, .throws = true } };
    const ops = table(Info, rows);
    const names = comptime std.meta.fieldNames(Keys(rows));
    try std.testing.expectEqual(@as(usize, 2), names.len);
    try std.testing.expectEqualStrings("at", names[0]);
    try std.testing.expectEqualStrings("union", names[1]);
    try std.testing.expect(!ops.get(.at).throws);
    try std.testing.expect(ops.get(.@"union").throws);
    try std.testing.expectEqual(@as(u8, 2), ops.get(.@"union").arity);
}

test "a union keeps every part's tags in order" {
    const Both = Union(&.{ enum { @"++", @"=" }, enum { @"+", in } });
    try std.testing.expectEqual(@as(usize, 4), std.meta.fieldNames(Both).len);
    try std.testing.expectEqualStrings("in", @tagName(Both.in));
    try std.testing.expectEqual(@as(?Both, .@"+"), std.meta.stringToEnum(Both, "+"));
}
