//! ECMA-262 semantics for the primitives const-fold evaluates. The TypeScript pass gets these from
//! the language it runs on; here they are spelled out, and `packages/tests/zigdiff` holds them to
//! the oracle's output byte for byte.
//!
//! Strings are WTF-8: UTF-8, plus the three-byte form of a lone surrogate, which a JavaScript
//! string may hold and UTF-8 cannot spell.

const std = @import("std");
const Allocator = std.mem.Allocator;
const jstext = @import("jstext");

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

pub const numberToString = jstext.numberToString;
pub const utf16Length = jstext.utf16Length;
pub const compareStrings = jstext.compare;

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
    const body = jstext.trim(text);
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

/// A trailing lone high surrogate and a leading lone low one become one astral character, as two
/// code units do in a JavaScript string; plain byte concatenation would keep two invalid halves.
pub fn concat(arena: Allocator, left: []const u8, right: []const u8) Allocator.Error![]const u8 {
    if (left.len >= 3 and right.len >= 3 and left[left.len - 3] == 0xed and right[0] == 0xed) {
        const high = jstext.decode(left[left.len - 3 ..]);
        const low = jstext.decode(right[0..3]);
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
