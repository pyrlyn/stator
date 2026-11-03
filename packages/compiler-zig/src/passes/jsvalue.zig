//! ECMA-262 semantics for the primitives const-fold evaluates. The TypeScript pass gets these from
//! the language it runs on; here they are spelled out, and `packages/tests/zigdiff` holds them to
//! the oracle's output byte for byte.
//!
//! Strings are WTF-8: UTF-8, plus the three-byte form of a lone surrogate, which a JavaScript
//! string may hold and UTF-8 cannot spell.

const std = @import("std");
const Allocator = std.mem.Allocator;

// libc rather than `std.math.pow`: V8 calls the platform's `pow`, and the two disagree in the last
// bits on most non-integral inputs, which a folded literal would print.
extern "c" fn pow(x: f64, y: f64) f64;

/// Number::exponentiate. Past the language's own departures from C99's `pow`, two exponents are
/// V8's: it answers them exactly, at every tier, where libc can be a unit in the last place off.
/// Agreement over 1.9 million pairs from Node 26.7 needed both. `x + 0` turns -0 into the +0 the
/// language wants; -Infinity stays with `pow`, because its square root is NaN and its power is not.
pub fn exponentiate(base: f64, exponent: f64) f64 {
    if (std.math.isNan(exponent)) return std.math.nan(f64);
    if (exponent == 0) return 1;
    if ((base == 1 or base == -1) and std.math.isInf(exponent)) return std.math.nan(f64);
    if (exponent == 2) return base * base;
    if (exponent == 0.5 and base != -std.math.inf(f64)) return @sqrt(base + 0.0);
    return pow(base, exponent);
}

pub fn toInt32(value: f64) i32 {
    return @bitCast(toUint32(value));
}

pub fn toUint32(value: f64) u32 {
    if (std.math.isNan(value) or std.math.isInf(value)) return 0;
    // `@mod` is exact on doubles, so this is the modular reduction the spec defines, including for
    // values far outside the range any integer type here could hold.
    const reduced = @mod(@trunc(value), 4294967296.0);
    return @intFromFloat(reduced);
}

/// Number::toString in radix 10.
pub fn numberToString(arena: Allocator, value: f64) Allocator.Error![]const u8 {
    if (std.math.isNan(value)) return "NaN";
    if (value == 0) return "0";
    if (std.math.isInf(value)) return if (value < 0) "-Infinity" else "Infinity";

    var buf: [std.fmt.float.min_buffer_size]u8 = undefined;
    // Scientific is the one rendering that hands back the shortest digits and the exponent apart.
    const rendered = std.fmt.float.render(&buf, @abs(value), .{ .mode = .scientific }) catch unreachable;
    const e_at = std.mem.indexOfScalar(u8, rendered, 'e').?;
    var digits_buf: [32]u8 = undefined;
    var k: usize = 0;
    for (rendered[0..e_at]) |ch| {
        if (ch == '.') continue;
        digits_buf[k] = ch;
        k += 1;
    }
    // Trailing zeros are not digits of the shortest form; the renderer never writes them, but the
    // length rules below would misread one.
    while (k > 1 and digits_buf[k - 1] == '0') k -= 1;
    const digits = digits_buf[0..k];
    const exponent = std.fmt.parseInt(i32, rendered[e_at + 1 ..], 10) catch unreachable;
    const n: i32 = exponent + 1;
    const k_int: i32 = @intCast(k);

    var out: std.ArrayList(u8) = .empty;
    if (value < 0) try out.append(arena, '-');
    if (k_int <= n and n <= 21) {
        try out.appendSlice(arena, digits);
        try out.appendNTimes(arena, '0', @intCast(n - k_int));
    } else if (0 < n and n <= 21) {
        const whole: usize = @intCast(n);
        try out.appendSlice(arena, digits[0..whole]);
        try out.append(arena, '.');
        try out.appendSlice(arena, digits[whole..]);
    } else if (-6 < n and n <= 0) {
        try out.appendSlice(arena, "0.");
        try out.appendNTimes(arena, '0', @intCast(-n));
        try out.appendSlice(arena, digits);
    } else {
        try out.append(arena, digits[0]);
        if (k > 1) {
            try out.append(arena, '.');
            try out.appendSlice(arena, digits[1..]);
        }
        try out.print(arena, "e{c}{d}", .{ @as(u8, if (n - 1 < 0) '-' else '+'), @abs(n - 1) });
    }
    return out.items;
}

fn whitespaceWidth(text: []const u8) usize {
    if (text.len == 0) return 0;
    switch (text[0]) {
        '\t', '\n', 0x0b, 0x0c, '\r', ' ' => return 1,
        else => {},
    }
    if (text[0] < 0x80) return 0;
    const width = std.unicode.utf8ByteSequenceLength(text[0]) catch return 0;
    if (width > text.len or width < 2) return 0;
    const point = std.unicode.utf8Decode(text[0..width]) catch return 0;
    return switch (point) {
        0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => width,
        else => 0,
    };
}

fn trim(text: []const u8) []const u8 {
    var rest = text;
    while (true) {
        const width = whitespaceWidth(rest);
        if (width == 0) break;
        rest = rest[width..];
    }
    outer: while (rest.len != 0) {
        var back: usize = 1;
        while (back <= 3 and back <= rest.len) : (back += 1) {
            const at = rest.len - back;
            if (whitespaceWidth(rest[at..]) == back) {
                rest = rest[0..at];
                continue :outer;
            }
        }
        break;
    }
    return rest;
}

fn digitsOf(text: []const u8) usize {
    var count: usize = 0;
    while (count < text.len and std.ascii.isDigit(text[count])) count += 1;
    return count;
}

/// The grammar check `std.fmt.parseFloat` cannot do for us: it also takes `inf`, `nan`, digit
/// separators and hex floats, none of which are a StringNumericLiteral.
fn isDecimalLiteral(text: []const u8) bool {
    var rest = text;
    if (rest.len != 0 and (rest[0] == '+' or rest[0] == '-')) rest = rest[1..];
    const whole = digitsOf(rest);
    rest = rest[whole..];
    var fraction: usize = 0;
    if (rest.len != 0 and rest[0] == '.') {
        rest = rest[1..];
        fraction = digitsOf(rest);
        rest = rest[fraction..];
    }
    if (whole == 0 and fraction == 0) return false;
    if (rest.len != 0 and (rest[0] == 'e' or rest[0] == 'E')) {
        rest = rest[1..];
        if (rest.len != 0 and (rest[0] == '+' or rest[0] == '-')) rest = rest[1..];
        const exponent = digitsOf(rest);
        if (exponent == 0) return false;
        rest = rest[exponent..];
    }
    return rest.len == 0;
}

/// A `0x`/`0o`/`0b` literal's value, rounded the way a decimal literal's is: to nearest, ties to
/// even. Only the leading 54 significant bits and a sticky bit decide that.
fn radixLiteral(text: []const u8, bits_per_digit: u6) f64 {
    if (text.len == 0) return std.math.nan(f64);
    var mantissa: u64 = 0;
    var exponent: i32 = 0;
    var sticky = false;
    for (text) |ch| {
        const digit = std.fmt.charToDigit(ch, @as(u8, 1) << @intCast(bits_per_digit)) catch return std.math.nan(f64);
        var bit: u6 = bits_per_digit;
        while (bit != 0) {
            bit -= 1;
            const set: u1 = @truncate(digit >> @intCast(bit));
            if (mantissa >> 54 == 0) {
                mantissa = mantissa << 1 | set;
            } else {
                exponent += 1;
                sticky = sticky or set == 1;
            }
        }
    }
    if (exponent == 0 and mantissa >> 53 == 0) return @floatFromInt(mantissa);
    // 55 bits are held: drop the lowest two against the sticky bit and round by hand, because a
    // cast from a u64 would round on the 55-bit value without knowing about the bits beyond it.
    while (mantissa >> 53 != 0) {
        sticky = sticky or mantissa & 1 == 1;
        mantissa >>= 1;
        exponent += 1;
        if (mantissa >> 53 == 0) break;
    }
    return std.math.ldexp(@as(f64, @floatFromInt(mantissa)), exponent);
}

/// StringToNumber.
pub fn stringToNumber(text: []const u8) f64 {
    const body = trim(text);
    if (body.len == 0) return 0;
    if (body.len >= 2 and body[0] == '0') {
        const rest = body[2..];
        switch (body[1]) {
            'x', 'X' => return radixLiteral(rest, 4),
            'o', 'O' => return radixLiteral(rest, 3),
            'b', 'B' => return radixLiteral(rest, 1),
            else => {},
        }
    }
    if (std.mem.eql(u8, body, "Infinity") or std.mem.eql(u8, body, "+Infinity")) return std.math.inf(f64);
    if (std.mem.eql(u8, body, "-Infinity")) return -std.math.inf(f64);
    if (!isDecimalLiteral(body)) return std.math.nan(f64);
    return std.fmt.parseFloat(f64, body) catch std.math.nan(f64);
}

const Decoded = struct { unit_a: u16, unit_b: ?u16, width: usize };

/// One WTF-8 sequence as the UTF-16 code units it stands for.
fn nextUnits(text: []const u8) Decoded {
    const first = text[0];
    if (first < 0x80) return .{ .unit_a = first, .unit_b = null, .width = 1 };
    if (first >= 0xf0) {
        const point: u32 = (@as(u32, first & 0x07) << 18) | (@as(u32, text[1] & 0x3f) << 12) |
            (@as(u32, text[2] & 0x3f) << 6) | (text[3] & 0x3f);
        const offset = point - 0x10000;
        return .{
            .unit_a = @intCast(0xd800 + (offset >> 10)),
            .unit_b = @intCast(0xdc00 + (offset & 0x3ff)),
            .width = 4,
        };
    }
    if (first >= 0xe0) {
        const unit: u32 = (@as(u32, first & 0x0f) << 12) | (@as(u32, text[1] & 0x3f) << 6) | (text[2] & 0x3f);
        return .{ .unit_a = @intCast(unit), .unit_b = null, .width = 3 };
    }
    const unit: u32 = (@as(u32, first & 0x1f) << 6) | (text[1] & 0x3f);
    return .{ .unit_a = @intCast(unit), .unit_b = null, .width = 2 };
}

/// `.length`: UTF-16 code units, so an astral character counts twice.
pub fn utf16Length(text: []const u8) usize {
    var units: usize = 0;
    var at: usize = 0;
    while (at < text.len) {
        const decoded = nextUnits(text[at..]);
        units += if (decoded.unit_b == null) 1 else 2;
        at += decoded.width;
    }
    return units;
}

/// Strings order by code unit, not by code point: an astral character sorts below U+E000 here,
/// and above it in the byte order of its UTF-8.
pub fn compareStrings(left: []const u8, right: []const u8) std.math.Order {
    var a: Units = .{ .text = left };
    var b: Units = .{ .text = right };
    while (true) {
        const unit_a = a.next();
        const unit_b = b.next();
        const x = unit_a orelse return if (unit_b == null) .eq else .lt;
        const y = unit_b orelse return .gt;
        if (x != y) return if (x < y) .lt else .gt;
    }
}

/// A string's UTF-16 units, decoded one at a time; the low surrogate of an astral character
/// waits in `pending`.
const Units = struct {
    text: []const u8,
    at: usize = 0,
    pending: ?u16 = null,

    fn next(self: *Units) ?u16 {
        if (self.pending) |unit| {
            self.pending = null;
            return unit;
        }
        if (self.at >= self.text.len) return null;
        const decoded = nextUnits(self.text[self.at..]);
        self.pending = decoded.unit_b;
        self.at += decoded.width;
        return decoded.unit_a;
    }
};

/// A trailing lone high surrogate and a leading lone low one become one astral character, as two
/// code units do in a JavaScript string; plain byte concatenation would keep two invalid halves.
pub fn concat(arena: Allocator, left: []const u8, right: []const u8) Allocator.Error![]const u8 {
    if (left.len >= 3 and right.len >= 3 and left[left.len - 3] == 0xed and right[0] == 0xed) {
        const high = nextUnits(left[left.len - 3 ..]).unit_a;
        const low = nextUnits(right).unit_a;
        if (high >= 0xd800 and high < 0xdc00 and low >= 0xdc00 and low < 0xe000) {
            const point: u32 = 0x10000 + ((@as(u32, high) - 0xd800) << 10) + (@as(u32, low) - 0xdc00);
            var joined: [4]u8 = undefined;
            _ = std.unicode.utf8Encode(@intCast(point), &joined) catch unreachable;
            return std.mem.concat(arena, u8, &.{ left[0 .. left.len - 3], &joined, right[3..] });
        }
    }
    return std.mem.concat(arena, u8, &.{ left, right });
}

const testing = std.testing;

test "numbers print the way String(n) does" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const cases = [_]struct { f64, []const u8 }{
        .{ 0, "0" },
        .{ -0.0, "0" },
        .{ 1, "1" },
        .{ -1.5, "-1.5" },
        .{ 1e21, "1e+21" },
        .{ 1e20, "100000000000000000000" },
        .{ 1.2345678901234568e20, "123456789012345680000" },
        .{ 0.000001, "0.000001" },
        .{ 0.0000001, "1e-7" },
        .{ 1.5e-7, "1.5e-7" },
        .{ 1.0 / 3.0, "0.3333333333333333" },
        .{ 5e-324, "5e-324" },
        .{ 1.7976931348623157e308, "1.7976931348623157e+308" },
    };
    for (cases) |case| try testing.expectEqualStrings(case[1], try numberToString(arena, case[0]));
    try testing.expectEqualStrings("NaN", try numberToString(arena, std.math.nan(f64)));
    try testing.expectEqualStrings("-Infinity", try numberToString(arena, -std.math.inf(f64)));
}

test "StringToNumber follows the literal grammar" {
    try testing.expectEqual(@as(f64, 5), stringToNumber("  5\n"));
    try testing.expectEqual(@as(f64, 0), stringToNumber(""));
    try testing.expectEqual(@as(f64, 0), stringToNumber(" \t"));
    try testing.expectEqual(@as(f64, 31), stringToNumber("0x1F"));
    try testing.expectEqual(@as(f64, 8), stringToNumber("0o10"));
    try testing.expectEqual(@as(f64, 5), stringToNumber("0b101"));
    try testing.expectEqual(@as(f64, 0.5), stringToNumber(".5"));
    try testing.expectEqual(@as(f64, 5), stringToNumber("5."));
    try testing.expectEqual(@as(f64, 1500), stringToNumber("1.5e3"));
    try testing.expectEqual(std.math.inf(f64), stringToNumber("Infinity"));
    try testing.expectEqual(@as(f64, 9007199254740992), stringToNumber("0x20000000000001"));
    try testing.expect(std.math.signbit(stringToNumber("-0")));
    for ([_][]const u8{ "inf", "nan", "1_000", "0x", "-0x10", "1e", ".", "+", "0x1p3", "12px" }) |bad| {
        try testing.expect(std.math.isNan(stringToNumber(bad)));
    }
}

test "ToInt32 wraps modulo two to the thirty-second" {
    try testing.expectEqual(@as(i32, -1), toInt32(4294967295));
    try testing.expectEqual(@as(i32, 0), toInt32(std.math.nan(f64)));
    try testing.expectEqual(@as(i32, -2147483648), toInt32(2147483648));
    try testing.expectEqual(@as(i32, -1), toInt32(-1.9));
    try testing.expectEqual(@as(u32, 4294967295), toUint32(-1));
}

test "strings compare and measure in UTF-16 code units" {
    try testing.expectEqual(@as(usize, 2), utf16Length("\u{1f600}"));
    try testing.expectEqual(@as(usize, 3), utf16Length("a\u{e9}\u{4e2d}"));
    // U+1F600 is 0xD83D 0xDE00 in code units, which orders below U+E000.
    try testing.expectEqual(std.math.Order.lt, compareStrings("\u{1f600}", "\u{e000}"));
    try testing.expectEqual(std.math.Order.lt, compareStrings("a", "ab"));
    try testing.expectEqual(std.math.Order.eq, compareStrings("ab", "ab"));
}

test "concatenation joins a split surrogate pair" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const joined = try concat(state.allocator(), "\xed\xa0\xbd", "\xed\xb8\x80");
    try testing.expectEqualStrings("\u{1f600}", joined);
}

test "exponentiation departs from pow only where the language does" {
    try testing.expect(std.math.isNan(exponentiate(1, std.math.inf(f64))));
    try testing.expect(std.math.isNan(exponentiate(-1, -std.math.inf(f64))));
    try testing.expect(std.math.isNan(exponentiate(2, std.math.nan(f64))));
    try testing.expectEqual(@as(f64, 1), exponentiate(std.math.nan(f64), 0));
    try testing.expectEqual(@as(f64, 1024), exponentiate(2, 10));
}

test "exponents 2 and 0.5 are exact where pow rounds a place away" {
    var base: f64 = -879.13642120361328;
    _ = &base;
    try testing.expectEqual(base * base, exponentiate(base, 2));
    const root = exponentiate(std.math.floatMax(f64), 0.5);
    try testing.expectEqual(@as(u64, 0x5fefffffffffffff), @as(u64, @bitCast(root)));
    try testing.expectEqual(@as(u64, 0), @as(u64, @bitCast(exponentiate(-0.0, 0.5))));
    try testing.expectEqual(std.math.inf(f64), exponentiate(-std.math.inf(f64), 0.5));
}
