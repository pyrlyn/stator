//! The pure layer of `ffi-gen-binding.test.ts`: the reverse-ABI matrix over hand-built models. Its
//! clang-gated half is `parity/ffigen.ts`, which compares whole runs instead.
const std = @import("std");
const Allocator = std.mem.Allocator;
const testing = std.testing;
const abi = @import("abi.zig");
const diff = @import("diff.zig");
const emit = @import("emit.zig");
const model_ = @import("model.zig");
const CFunction = model_.CFunction;
const CParam = model_.CParam;
const CRecord = model_.CRecord;
const HeaderModel = model_.HeaderModel;
const mapCType = abi.mapCType;
const tsFunctionName = abi.tsFunctionName;

const empty: HeaderModel = .{ .basename = "test.h" };

const Alias = struct { name: []const u8, underlying: []const u8, anon: ?[]const u8 = null };

fn modelWith(a: Allocator, aliases: []const Alias, records: []const CRecord) !HeaderModel {
    var out = empty;
    for (aliases) |alias| try out.typedefs.put(a, alias.name, .{ .name = alias.name, .underlying = alias.underlying, .anon_tag_id = alias.anon });
    for (records) |record| try out.records_by_id.put(a, record.id, record);
    return out;
}

fn cfn(a: Allocator, c_name: []const u8, types: []const []const u8, return_type: []const u8) !CFunction {
    const params = try a.alloc(CParam, types.len);
    for (types, params, 0..) |c_type, *param, index| param.* = .{ .name = try std.fmt.allocPrint(a, "a{d}", .{index}), .c_type = c_type };
    return .{ .c_name = c_name, .line = 1, .params = params, .return_type = return_type, .variadic = false, .is_inline = false, .is_static = false, .has_body = false };
}

fn expectMapped(a: Allocator, expected: []const u8, c_type: []const u8, position: abi.Position, m: *const HeaderModel) !void {
    const value = switch (mapCType(a, c_type, m, position)) {
        .ok => |ok| ok,
        .refused => |r| {
            std.debug.print("expected '{s}' to map, refused: {s}\n", .{ c_type, r.reason });
            return error.TestUnexpectedResult;
        },
    };
    const got = switch (value) {
        .primitive => |p| @tagName(p.ts),
        .out_param => |brand| try std.fmt.allocPrint(a, "out:{s}", .{brand.alias}),
        .pointer => |brand| try std.fmt.allocPrint(a, "pointer:{s}", .{brand.alias}),
    };
    try testing.expectEqualStrings(expected, got);
}

/// Refused, with the words the TS test matches and the code.
fn expectRefused(a: Allocator, word: []const u8, code: ?[]const u8, c_type: []const u8, position: abi.Position, m: *const HeaderModel) !void {
    switch (mapCType(a, c_type, m, position)) {
        .ok => {
            std.debug.print("expected '{s}' to be refused\n", .{c_type});
            return error.TestUnexpectedResult;
        },
        .refused => |r| {
            if (std.mem.indexOf(u8, r.reason, word) == null) {
                std.debug.print("'{s}' not in: {s}\n", .{ word, r.reason });
                return error.TestUnexpectedResult;
            }
            if (code) |wanted| try testing.expectEqualStrings(wanted, r.code.?);
        },
    }
}

test "C names camelCase mechanically, never guessing a library prefix" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("sqlite3Step", tsFunctionName(a, "sqlite3_step"));
    try testing.expectEqualStrings("sqlite3LibversionNumber", tsFunctionName(a, "sqlite3_libversion_number"));
    try testing.expectEqualStrings("plainAdd", tsFunctionName(a, "plain_add"));
    try testing.expectEqualStrings("deleteFn", tsFunctionName(a, "delete"));
    try testing.expectEqualStrings("fn", tsFunctionName(a, "___"));
    try testing.expectEqualStrings("_1a", tsFunctionName(a, "1a"));
}

test "scalars map through the reverse table; void is return-only" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_]struct { []const u8, []const u8, abi.Position }{
        .{ "number", "double", .param },
        .{ "number", "float", .@"return" },
        .{ "number", "int", .param },
        .{ "number", "unsigned int", .@"return" },
        .{ "number", "short", .param },
        .{ "number", "unsigned char", .@"return" },
        .{ "boolean", "bool", .param },
        .{ "boolean", "_Bool", .@"return" },
        .{ "void", "void", .@"return" },
    }) |row| try expectMapped(a, row[0], row[1], row[2], &empty);
    try expectRefused(a, "return position only", null, "void", .param, &empty);
}

test "strings follow the const rule: borrow in, copy out, never mutable" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectMapped(a, "cstring", "const char *", .param, &empty);
    try expectMapped(a, "cstring", "const unsigned char *", .@"return", &empty);
    try expectMapped(a, "cstring", "char *", .@"return", &empty);
    try expectRefused(a, "mutable", null, "char *", .param, &empty);
    try expectRefused(a, "mutable", null, "char * const", .param, &empty);
}

test "struct pointers brand; unions, bitfields, and T** refuse" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = try modelWith(a, &.{.{ .name = "Node", .underlying = "struct Node" }}, &.{
        .{ .id = "r1", .name = "Node", .tag = .@"struct", .complete = true, .has_bitfield = false },
        .{ .id = "r2", .name = "Bits", .tag = .@"struct", .complete = true, .has_bitfield = true },
    });
    try expectMapped(a, "pointer:Ptr_Node", "Node *", .param, &m);
    try expectMapped(a, "pointer:Ptr_Node", "struct Node *", .param, &m);
    try expectMapped(a, "out:Ptr_Node", "Node **", .param, &m);
    try expectMapped(a, "out:Ptr_Node", "struct Node **", .param, &m);
    try expectRefused(a, "return position", "STA1119", "Node **", .@"return", &m);
    try expectMapped(a, "out:CString", "const char **", .param, &m);
    try expectRefused(a, "not a branded pointer", "STA1119", "int **", .param, &m);
    try expectRefused(a, "mutable", "STA1119", "char **", .param, &m);
    try expectRefused(a, "T***", "STA1119", "Node ***", .param, &m);
    try expectRefused(a, "T**", "STA1119", "Node ***", .@"return", &m);
    try expectRefused(a, "bitfield", null, "struct Bits *", .param, &m);
    try expectRefused(a, "union", null, "union U *", .param, &m);
    try expectRefused(a, "union", null, "union U", .param, &m);
    try expectRefused(a, "by value", null, "struct Node", .param, &m);
}

test "an anonymous struct behind a typedef is still a branded pointer" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = try modelWith(a, &.{.{ .name = "Point", .underlying = "struct Point", .anon = "anon1" }}, &.{
        .{ .id = "anon1", .name = null, .tag = .@"struct", .complete = true, .has_bitfield = false },
    });
    try expectMapped(a, "pointer:Ptr_Point", "Point *", .param, &m);
}

test "typedef chains that hide declarator depth re-enter the full analysis" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = try modelWith(a, &.{
        .{ .name = "sqlite3_filename", .underlying = "const char *" },
        .{ .name = "NodePtr", .underlying = "struct Node *" },
        .{ .name = "cb_t", .underlying = "void (*)(int)" },
        .{ .name = "loop_a", .underlying = "loop_b" },
        .{ .name = "loop_b", .underlying = "loop_a" },
    }, &.{.{ .id = "r1", .name = "Node", .tag = .@"struct", .complete = true, .has_bitfield = false }});
    try expectMapped(a, "cstring", "sqlite3_filename", .param, &m);
    try expectMapped(a, "out:Ptr_Node", "NodePtr *", .param, &m);
    try expectMapped(a, "pointer:Ptr_Node", "NodePtr", .param, &m);
    try expectRefused(a, "function pointer", "STA1117", "cb_t", .param, &m);
    try expectRefused(a, "unknown type", "STA1119", "loop_a", .param, &m);
}

test "64-bit integers refuse; size_t widens by documented rule" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = try modelWith(a, &.{ .{ .name = "my_ulong", .underlying = "unsigned long" }, .{ .name = "i64_t", .underlying = "long long" }, .{ .name = "sqlite3_int64", .underlying = "long long" } }, &.{});
    for ([_][]const u8{ "long", "unsigned long", "long long", "int64_t", "uint64_t" }) |spelling| try expectRefused(a, "64-bit", null, spelling, .@"return", &empty);
    for ([_][]const u8{ "my_ulong", "i64_t", "sqlite3_int64" }) |spelling| try expectRefused(a, "64-bit", null, spelling, .@"return", &m);
    try expectMapped(a, "number", "size_t", .@"return", &empty);
    try expectMapped(a, "number", "size_t", .param, &empty);
}

test "void*, scalar pointers, arrays, fn pointers, and unknowns refuse with their codes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectMapped(a, "pointer:Ptr_void", "void *", .param, &empty);
    try expectRefused(a, "allocator", null, "void *", .@"return", &empty);
    try expectRefused(a, "out-param/array", null, "int *", .param, &empty);
    try expectRefused(a, "array type", "STA1116", "char [64]", .param, &empty);
    try expectRefused(a, "function pointer", "STA1117", "void (*)(int)", .param, &empty);
    try expectRefused(a, "unknown type", "STA1119", "mystery_t", .param, &empty);
    try expectMapped(a, "number", "enum Color", .@"return", &empty);
}

fn refusalOf(mapping: abi.FunctionMapping) !abi.Refusal {
    return switch (mapping) {
        .ok => error.TestUnexpectedResult,
        .refused => |r| r,
    };
}

test "function-level scope refusals precede the positions, with the gate order inside" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var fn_ = try cfn(a, "f", &.{"const char *"}, "int");
    fn_.variadic = true;
    var taken: abi.Names = .empty;
    try testing.expectEqualStrings("STA1120", (try refusalOf(abi.classifyFunction(a, &fn_, &empty, &taken))).code.?);
    for ([_][]const u8{ "is_inline", "is_static", "has_body" }) |field| {
        var bare = try cfn(a, "f", &.{}, "void");
        if (std.mem.eql(u8, field, "is_inline")) bare.is_inline = true;
        if (std.mem.eql(u8, field, "is_static")) bare.is_static = true;
        if (std.mem.eql(u8, field, "has_body")) bare.has_body = true;
        _ = try refusalOf(abi.classifyFunction(a, &bare, &empty, &taken));
    }
    const bad = try cfn(a, "f", &.{ "int", "void (*)(int)" }, "mystery_t");
    const refusal = try refusalOf(abi.classifyFunction(a, &bad, &empty, &taken));
    try testing.expect(std.mem.indexOf(u8, refusal.reason, "parameter 2") != null);
    try testing.expectEqualStrings("STA1117", refusal.code.?);
    var names: abi.Names = .empty;
    try names.put(a, "plainAdd", {});
    const collision = try cfn(a, "plain_add", &.{}, "void");
    try testing.expect(std.mem.indexOf(u8, (try refusalOf(abi.classifyFunction(a, &collision, &empty, &names))).reason, "collides") != null);
}

test "a long signature wraps at the print width, and refusals sort by line" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var m = empty;
    const types: [8][]const u8 = @splat("const char *");
    const functions = [_]CFunction{ try cfn(a, "takes_many_string_arguments", &types, "void"), try cfn(a, "b_bad", &.{"int *"}, "void") };
    m.functions = &functions;
    const result = emit.generate(a, &m);
    const dts = emit.renderDts(a, &result, &.{"m"});
    try testing.expect(std.mem.indexOf(u8, dts, "declare function takesManyStringArguments(\n  a0: CString,\n") != null);
    try testing.expect(std.mem.indexOf(u8, dts, "// @statorLink: -lm\n// @statorLink #include \"./test.h\"\n") != null);
    try testing.expectEqualStrings("ffi-gen: 1 emitted, 1 refused (scalar pointer: 1) from test.h", emit.summaryLine(a, &result));
    try testing.expect(std.mem.endsWith(u8, dts, "[would-be STA1119]\n"));
}

test "the diff matches by C symbol and names what differs" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var m = empty;
    const functions = [_]CFunction{
        try cfn(a, "same_one", &.{"int"}, "int"),
        try cfn(a, "other", &.{"int"}, "int"),
        try cfn(a, "only_gen", &.{}, "void"),
        try cfn(a, "refused", &.{"int *"}, "void"),
    };
    m.functions = &functions;
    const result = emit.generate(a, &m);
    const hand = [_]diff.HandFunction{
        .{ .ts_name = "sameOne", .c_name = "same_one", .param_types = &.{"number"}, .ret_type = "number" },
        .{ .ts_name = "renamed", .c_name = "other", .param_types = &.{"string"}, .ret_type = "number" },
        .{ .ts_name = "refused", .c_name = "refused", .param_types = &.{"number"}, .ret_type = "void" },
        .{ .ts_name = "gone", .c_name = "gone", .param_types = &.{}, .ret_type = "void" },
    };
    const report = diff.renderDiffReport(a, diff.diffBindings(a, &result, &hand), "a.h", "a.d.ts");
    try testing.expectEqualStrings(
        \\oracle diff: generated a.h vs hand-written a.d.ts
        \\5 C symbols compared: 1 match, 1 mismatch, 1 gen-only, 1 hand-only-emittable, 1 hand-only-refused
        \\  [hand-only-emittable] gone: hand-written as gone but no header declaration found (renamed? from another header?)
        \\  [gen-only] only_gen: generated as onlyGen(): void
        \\  [mismatch] other: ts-name gen=`other` hand=`renamed`; params gen=`(number)` hand=`(string)`
        \\  [hand-only-refused] refused: generator refuses: parameter 1 ('int *'): scalar pointer 'int*' is an out-param/array shape with no ABI row (docs/FFI.md)
        \\
    , report);
}
