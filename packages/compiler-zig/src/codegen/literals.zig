//! How values are spelled inside generated C: numbers, strings, member names. Mirrors the pure half
//! of `packages/compiler/src/codegen/helpers.ts`, which keeps the reasoning for each rule. Nothing
//! here reads the HIR, so a generated-C difference in a literal is caught by the tests in this file
//! before any fixture runs.

const std = @import("std");
const Allocator = std.mem.Allocator;
const numberToString = @import("../passes/jsvalue.zig").numberToString;

/// A C literal that parses back to the same double, the sign of zero and a too-large integer's
/// legality included.
pub fn cDoubleLiteral(arena: Allocator, value: f64) Allocator.Error![]const u8 {
    if (std.math.isNan(value)) return "(0.0 / 0.0)";
    if (std.math.isInf(value)) return if (value > 0) "(1.0 / 0.0)" else "(-1.0 / 0.0)";
    if (value == 0 and std.math.signbit(value)) return "-0.0";
    const text = try numberToString(arena, value);
    if (std.mem.indexOfAny(u8, text, ".eE") != null) return text;
    return std.fmt.allocPrint(arena, "{s}.0", .{text});
}

/// A surrogate half in WTF-8 is `ED` then `A0`–`AF` (high) or `B0`–`BF` (low): `lead` picks which.
fn surrogateHalfAt(value: []const u8, at: usize, lead: u8) bool {
    return at + 2 < value.len and value[at] == 0xed and value[at + 1] & 0xf0 == lead;
}

/// HIR strings are WTF-8, where a JS string's two surrogate halves may sit side by side after a
/// concatenation. The UTF-16 walk in `wtf8Bytes` would read those as one code point, so they merge
/// here; a truly lone surrogate keeps its three bytes.
pub fn wtf8Bytes(arena: Allocator, value: []const u8) Allocator.Error![]const u8 {
    if (std.mem.indexOfScalar(u8, value, 0xed) == null) return value;
    var out: std.ArrayList(u8) = .empty;
    try out.ensureTotalCapacity(arena, value.len);
    var i: usize = 0;
    while (i < value.len) {
        if (surrogateHalfAt(value, i, 0xa0) and surrogateHalfAt(value, i + 3, 0xb0)) {
            const high: u32 = (@as(u32, value[i + 1] & 0x0f) << 6) | (value[i + 2] & 0x3f);
            const low: u32 = (@as(u32, value[i + 4] & 0x0f) << 6) | (value[i + 5] & 0x3f);
            const code: u32 = 0x10000 + (high << 10) + low;
            try out.appendSlice(arena, &.{
                @intCast(0xf0 | (code >> 18)),
                @intCast(0x80 | ((code >> 12) & 0x3f)),
                @intCast(0x80 | ((code >> 6) & 0x3f)),
                @intCast(0x80 | (code & 0x3f)),
            });
            i += 6;
            continue;
        }
        try out.append(arena, value[i]);
        i += 1;
    }
    return out.items;
}

/// Octal rather than `\x`, which would swallow a following hex digit; `?` for C11 trigraphs.
pub fn escapeBytes(arena: Allocator, bytes: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.ensureTotalCapacity(arena, bytes.len);
    for (bytes) |byte| {
        switch (byte) {
            0x0a => try out.appendSlice(arena, "\\n"),
            0x09 => try out.appendSlice(arena, "\\t"),
            0x0d => try out.appendSlice(arena, "\\r"),
            0x5c => try out.appendSlice(arena, "\\\\"),
            0x22 => try out.appendSlice(arena, "\\\""),
            0x3f => try out.appendSlice(arena, "\\?"),
            0x20...0x21, 0x23...0x3e, 0x40...0x5b, 0x5d...0x7e => try out.append(arena, byte),
            else => try out.print(arena, "\\{o:0>3}", .{byte}),
        }
    }
    return out.items;
}

pub fn escapeCString(arena: Allocator, text: []const u8) Allocator.Error![]const u8 {
    return escapeBytes(arena, try wtf8Bytes(arena, text));
}

pub fn cNameLiteral(arena: Allocator, name: []const u8) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(arena, "\"{s}\"", .{try escapeCString(arena, name)});
}

/// The runtime's naming rule for a JS member: `charCodeAt` is `char_code_at`.
pub fn snakeCase(arena: Allocator, member: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.ensureTotalCapacity(arena, member.len);
    for (member) |c| {
        if (c >= 'A' and c <= 'Z') {
            try out.append(arena, '_');
            try out.append(arena, c + ('a' - 'A'));
        } else {
            try out.append(arena, c);
        }
    }
    return out.items;
}

const default_export_binding = "*default*";

/// The lowering mints shadow names, so it owns their format too.
const shadowSource = @import("../lower/scope.zig").shadowSource;

/// The name a class prints: a shape none, a shadowed class its source name, an anonymous default
/// export `default`, a specialization its generic's name.
pub fn descriptorName(name: []const u8) []const u8 {
    if (std.mem.startsWith(u8, name, "{")) return "";
    const unshadowed = shadowSource(name) orelse name;
    if (std.mem.eql(u8, unshadowed, default_export_binding)) return "default";
    const generic = std.mem.indexOfScalar(u8, unshadowed, '<') orelse return unshadowed;
    return unshadowed[0..generic];
}

/// `#`-prefixed so every reflective walk already filters it: storage, not a property.
pub fn hiddenMethodField(arena: Allocator, method: []const u8) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(arena, "#method:{s}", .{method});
}

pub fn exportInitName(arena: Allocator, unit: []const u8) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(arena, "stator_{s}_init", .{unit});
}

pub fn exportLastErrorName(arena: Allocator, unit: []const u8) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(arena, "stator_{s}_last_error", .{unit});
}

const testing = std.testing;

test "double literals stay floating and keep the sign of zero" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    try testing.expectEqualStrings("7.0", try cDoubleLiteral(arena, 7));
    try testing.expectEqualStrings("0.0", try cDoubleLiteral(arena, 0));
    try testing.expectEqualStrings("-0.0", try cDoubleLiteral(arena, -0.0));
    try testing.expectEqualStrings("0.5", try cDoubleLiteral(arena, 0.5));
    try testing.expectEqualStrings("100000000000000000000.0", try cDoubleLiteral(arena, 1e20));
    try testing.expectEqualStrings("1e+21", try cDoubleLiteral(arena, 1e21));
    try testing.expectEqualStrings("(0.0 / 0.0)", try cDoubleLiteral(arena, std.math.nan(f64)));
    try testing.expectEqualStrings("(1.0 / 0.0)", try cDoubleLiteral(arena, std.math.inf(f64)));
    try testing.expectEqualStrings("(-1.0 / 0.0)", try cDoubleLiteral(arena, -std.math.inf(f64)));
}

test "byte escapes match the TS table" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    try testing.expectEqualStrings("a\\n\\t\\r\\\\\\\"\\?b", try escapeBytes(arena, "a\n\t\r\\\"?b"));
    try testing.expectEqualStrings("\\000\\037\\177\\200\\377", try escapeBytes(arena, "\x00\x1f\x7f\x80\xff"));
    try testing.expectEqualStrings("\\303\\251", try escapeCString(arena, "é"));
    try testing.expectEqualStrings("\"a\\?\"", try cNameLiteral(arena, "a?"));
}

test "adjacent surrogate halves merge and a lone one keeps three bytes" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    // U+D83D then U+DE00 is U+1F600.
    try testing.expectEqualSlices(u8, "\xf0\x9f\x98\x80", try wtf8Bytes(arena, "\xed\xa0\xbd\xed\xb8\x80"));
    try testing.expectEqualSlices(u8, "\xed\xa0\x80", try wtf8Bytes(arena, "\xed\xa0\x80"));
    try testing.expectEqualSlices(u8, "\xed\xb0\x80\xed\xa0\x80", try wtf8Bytes(arena, "\xed\xb0\x80\xed\xa0\x80"));
    // U+D7FF is an ordinary three-byte scalar that shares the lead byte.
    try testing.expectEqualSlices(u8, "\xed\x9f\xbf", try wtf8Bytes(arena, "\xed\x9f\xbf"));
}

test "member and descriptor names" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    try testing.expectEqualStrings("char_code_at", try snakeCase(arena, "charCodeAt"));
    try testing.expectEqualStrings("get_own_property_names", try snakeCase(arena, "getOwnPropertyNames"));
    try testing.expectEqualStrings("", descriptorName("{x,y}"));
    try testing.expectEqualStrings("Box", descriptorName("Box<number>"));
    try testing.expectEqualStrings("default", descriptorName("*default*"));
    try testing.expectEqualStrings("C", descriptorName("\x00shadow:C#4"));
    try testing.expectEqualStrings("\x00shadow:", descriptorName("\x00shadow:"));
    try testing.expectEqualStrings("#method:go", try hiddenMethodField(arena, "go"));
    try testing.expectEqualStrings("stator_u_init", try exportInitName(arena, "u"));
    try testing.expectEqualStrings("stator_u_last_error", try exportLastErrorName(arena, "u"));
}
