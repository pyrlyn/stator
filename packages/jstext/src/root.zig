//! JavaScript's reading of text held as WTF-8: UTF-8, plus the three-byte form of a lone surrogate,
//! which a JavaScript string may hold and UTF-8 cannot spell. `Number::toString`, `\s`, `.length`,
//! string order and `JSON.stringify` of a string, as ECMA-262 defines them. Shared by stator-ts
//! (`packages/transpiler`) and the Zig compiler (`packages/compiler-zig`), whose output is compared
//! byte for byte with programs that get these from the language they run on.

const std = @import("std");
const Allocator = std.mem.Allocator;
const unicode = std.unicode;

/// Number::toString in radix 10: the shortest digits that read back as `value`, written out in
/// full from 1e-6 up to 1e21 and in exponent form outside that range.
pub fn numberToString(a: Allocator, value: f64) Allocator.Error![]const u8 {
    if (std.math.isNan(value)) return "NaN";
    if (value == 0) return "0";
    if (std.math.isInf(value)) return if (value < 0) "-Infinity" else "Infinity";
    // Below 2^53 every integer is exact, and its decimal form is its shortest digits.
    if (value == @trunc(value) and @abs(value) < 1e15) return std.fmt.allocPrint(a, "{d}", .{@as(i64, @intFromFloat(value))});

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
    if (value < 0) try out.append(a, '-');
    if (k_int <= n and n <= 21) {
        try out.appendSlice(a, digits);
        try out.appendNTimes(a, '0', @intCast(n - k_int));
    } else if (0 < n and n <= 21) {
        const whole: usize = @intCast(n);
        try out.appendSlice(a, digits[0..whole]);
        try out.append(a, '.');
        try out.appendSlice(a, digits[whole..]);
    } else if (-6 < n and n <= 0) {
        try out.appendSlice(a, "0.");
        try out.appendNTimes(a, '0', @intCast(-n));
        try out.appendSlice(a, digits);
    } else {
        try out.append(a, digits[0]);
        if (k > 1) {
            try out.append(a, '.');
            try out.appendSlice(a, digits[1..]);
        }
        try out.print(a, "e{c}{d}", .{ @as(u8, if (n - 1 < 0) '-' else '+'), @abs(n - 1) });
    }
    return out.items;
}

/// The value of a NumericLiteral as the lexer read it (ECMA-262 §12.9.3.3): separators, binary,
/// octal and hex, and Annex B's legacy octal `017`; a leading-zero decimal `089` reads as decimal.
/// Null for text that is not one. Past 64 bits a binary, octal or hex literal is read as a big
/// integer and rounded once to the nearest double, as tsgo does.
pub fn numericLiteral(raw: []const u8) ?f64 {
    if (raw.len > 2 and raw[0] == '0') switch (raw[1]) {
        'x', 'X' => return radixLiteral(raw[2..], 16),
        'o', 'O' => return radixLiteral(raw[2..], 8),
        'b', 'B' => return radixLiteral(raw[2..], 2),
        else => {},
    };
    if (raw.len > 1 and raw[0] == '0' and std.mem.indexOfNone(u8, raw, "01234567") == null) return radixLiteral(raw[1..], 8);
    return std.fmt.parseFloat(f64, raw) catch null;
}

fn radixLiteral(digits: []const u8, base: u8) ?f64 {
    if (std.fmt.parseInt(u64, digits, base)) |v| return @floatFromInt(v) else |e| if (e == error.InvalidCharacter) return null;
    var m = std.math.big.int.Managed.init(std.heap.page_allocator) catch return null;
    defer m.deinit();
    m.setString(base, digits) catch return null;
    return m.toFloat(f64, .nearest_even)[0];
}

/// JavaScript's `\s`: WhiteSpace and LineTerminator.
pub fn isSpace(cp: u21) bool {
    return switch (cp) {
        0x09...0x0d, 0x20, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => true,
        else => false,
    };
}

pub const CodePoint = struct { cp: u21, len: u3 };

/// The UTF-8 code point at `i` and its width, or null where the bytes there do not decode.
pub fn codePointAt(s: []const u8, i: usize) ?CodePoint {
    const len = unicode.utf8ByteSequenceLength(s[i]) catch return null;
    if (i + len > s.len) return null;
    const cp = unicode.utf8Decode(s[i .. i + len]) catch return null;
    return .{ .cp = cp, .len = len };
}

/// The bytes of the `\s` starting at `i`, or 0.
pub fn spaceAt(s: []const u8, i: usize) usize {
    if (i >= s.len) return 0;
    const at = codePointAt(s, i) orelse return 0;
    return if (isSpace(at.cp)) at.len else 0;
}

/// The bytes of the `\s` ending at `end`, or 0.
pub fn spaceBefore(s: []const u8, end: usize) usize {
    if (end == 0) return 0;
    var start = end - 1;
    while (start > 0 and end - start < 4 and s[start] & 0xc0 == 0x80) start -= 1;
    const at = codePointAt(s, start) orelse return 0;
    return if (start + at.len == end and isSpace(at.cp)) at.len else 0;
}

pub fn skipSpaces(s: []const u8, from: usize) usize {
    var i = from;
    while (true) {
        const len = spaceAt(s, i);
        if (len == 0) return i;
        i += len;
    }
}

pub fn skipSpacesBack(s: []const u8, from: usize) usize {
    var end = from;
    while (true) {
        const len = spaceBefore(s, end);
        if (len == 0) return end;
        end -= len;
    }
}

pub fn trimStart(s: []const u8) []const u8 {
    return s[skipSpaces(s, 0)..];
}

/// `String.prototype.trim`.
pub fn trim(s: []const u8) []const u8 {
    const head = trimStart(s);
    return head[0..skipSpacesBack(head, head.len)];
}

/// Never fails: a sequence that does not decode reads as U+FFFD, as wide as its lead byte claims
/// (cut at the end), and a byte that cannot lead one reads as itself.
pub const CodePoints = struct {
    bytes: []const u8,
    at: usize = 0,

    pub const Item = struct { cp: u21, start: usize, end: usize };

    pub fn next(it: *CodePoints) ?Item {
        if (it.at >= it.bytes.len) return null;
        const start = it.at;
        const len = unicode.utf8ByteSequenceLength(it.bytes[start]) catch 1;
        const end = @min(start + len, it.bytes.len);
        it.at = end;
        return .{ .cp = unicode.utf8Decode(it.bytes[start..end]) catch 0xFFFD, .start = start, .end = end };
    }
};

/// Bytes of the WTF-8 sequence led by `lead`, as its lead byte claims.
pub fn sequenceLength(lead: u8) u3 {
    return if (lead >= 0xf0) 4 else if (lead >= 0xe0) 3 else if (lead >= 0xc0) 2 else 1;
}

/// The code point of one whole WTF-8 sequence, a lone surrogate included.
pub fn decode(seq: []const u8) u21 {
    const head: u21 = switch (seq.len) {
        4 => seq[0] & 0x07,
        3 => seq[0] & 0x0f,
        2 => seq[0] & 0x1f,
        else => seq[0],
    };
    var cp = head;
    for (seq[1..]) |b| cp = cp << 6 | (b & 0x3f);
    return cp;
}

/// A string's UTF-16 code units, decoded one at a time; the low surrogate of an astral character
/// waits in `pending`.
pub const Units = struct {
    text: []const u8,
    at: usize = 0,
    pending: ?u16 = null,

    pub fn next(self: *Units) ?u16 {
        if (self.pending) |unit| {
            self.pending = null;
            return unit;
        }
        if (self.at >= self.text.len) return null;
        const len = @min(sequenceLength(self.text[self.at]), self.text.len - self.at);
        const cp = decode(self.text[self.at..][0..len]);
        self.at += len;
        if (cp < 0x10000) return @intCast(cp);
        const offset = cp - 0x10000;
        self.pending = @intCast(0xdc00 + (offset & 0x3ff));
        return @intCast(0xd800 + (offset >> 10));
    }
};

/// `.length`: UTF-16 code units, so an astral character counts twice.
pub fn utf16Length(s: []const u8) usize {
    var n: usize = 0;
    for (s) |b| {
        if (b & 0xc0 != 0x80) n += if (b >= 0xf0) 2 else 1;
    }
    return n;
}

/// Strings order by code unit, not by code point: an astral character sorts below U+E000 here,
/// and above it in the byte order of its UTF-8.
pub fn compare(left: []const u8, right: []const u8) std.math.Order {
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

/// JavaScript's `<` on strings.
pub fn less(x: []const u8, y: []const u8) bool {
    return compare(x, y) == .lt;
}

/// `JSON.stringify` of a string, lone surrogates included.
pub fn writeJsonString(w: *std.Io.Writer, s: []const u8) std.Io.Writer.Error!void {
    try w.writeByte('"');
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        switch (c) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            0x08 => try w.writeAll("\\b"),
            0x0c => try w.writeAll("\\f"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            0...0x07, 0x0b, 0x0e...0x1f => try w.print("\\u{x:0>4}", .{c}),
            0xed => if (i + 2 < s.len and s[i + 1] >= 0xa0) {
                const unit = @as(u16, 0xd000) | @as(u16, s[i + 1] & 0x3f) << 6 | (s[i + 2] & 0x3f);
                try w.print("\\u{x:0>4}", .{unit});
                i += 2;
            } else try w.writeByte(c),
            else => try w.writeByte(c),
        }
    }
    try w.writeByte('"');
}

const testing = std.testing;

test "Number::toString" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cases = [_]struct { f64, []const u8 }{
        .{ 1, "1" },                                         .{ -2, "-2" },
        .{ 1.5, "1.5" },                                     .{ @as(f64, 0.1) + @as(f64, 0.2), "0.30000000000000004" },
        .{ 1e21, "1e+21" },                                  .{ 1e20, "100000000000000000000" },
        .{ 1e-7, "1e-7" },                                   .{ 0.000001, "0.000001" },
        .{ 1.2345678901234568e20, "123456789012345680000" }, .{ -1.5e-10, "-1.5e-10" },
        .{ 1e15, "1000000000000000" },                       .{ 1.0 / 3.0, "0.3333333333333333" },
        .{ 5e-324, "5e-324" },                               .{ 1.7976931348623157e308, "1.7976931348623157e+308" },
        .{ 2.5e300, "2.5e+300" },
    };
    for (cases) |c| try testing.expectEqualStrings(c[1], try numberToString(a, c[0]));
    try testing.expectEqualStrings("NaN", try numberToString(a, std.math.nan(f64)));
    try testing.expectEqualStrings("0", try numberToString(a, -0.0));
    try testing.expectEqualStrings("-Infinity", try numberToString(a, -std.math.inf(f64)));
}

test "NumericLiteral values" {
    try std.testing.expectEqual(@as(?f64, 1000.5), numericLiteral("1_000.5"));
    try std.testing.expectEqual(@as(?f64, 255), numericLiteral("0xF_F"));
    try std.testing.expectEqual(@as(?f64, 5), numericLiteral("0b101"));
    try std.testing.expectEqual(@as(?f64, 15), numericLiteral("0o17"));
    try std.testing.expectEqual(@as(?f64, 15), numericLiteral("017"));
    try std.testing.expectEqual(@as(?f64, 89), numericLiteral("089"));
    try std.testing.expectEqual(@as(?f64, 0), numericLiteral("0"));
    try std.testing.expectEqual(@as(?f64, 0.0005), numericLiteral(".5e-3"));
    try std.testing.expectEqual(@as(?f64, 1e100), numericLiteral("1" ++ ("0000000000" ++ "0000000000") ++ ("0000000000" ++ "0000000000") ++ ("0000000000" ++ "0000000000") ++ ("0000000000" ++ "0000000000") ++ ("0000000000" ++ "0000000000")));
    try std.testing.expectEqual(@as(?f64, 0x1p72), numericLiteral("0x1000000000000000000"));
    try std.testing.expectEqual(@as(?f64, null), numericLiteral("0xZ"));
}

test "the \\s set, not ASCII's" {
    try testing.expectEqualStrings("a \u{a0}b", trim(" \u{3000}\ta \u{a0}b\u{feff}\r"));
    try testing.expectEqualStrings("", trim(" \u{2028}\t"));
    try testing.expect(isSpace(0x3000) and !isSpace('a') and !isSpace(0x200b));
}

test "a malformed sequence is one code point as wide as it claims" {
    var it: CodePoints = .{ .bytes = "a\xe2\x80 \xff" };
    const want = [_]CodePoints.Item{
        .{ .cp = 'a', .start = 0, .end = 1 },
        .{ .cp = 0xFFFD, .start = 1, .end = 4 },
        .{ .cp = 0xff, .start = 4, .end = 5 },
    };
    for (want) |item| try testing.expectEqual(item, it.next().?);
    try testing.expectEqual(@as(?CodePoints.Item, null), it.next());
}

test "UTF-16 order and length, lone surrogates included" {
    try testing.expect(less("a", "b") and less("a", "ab") and !less("a", "a"));
    try testing.expect(less("\u{10000}", "\u{e000}") and !less("\u{e000}", "\u{10000}"));
    try testing.expectEqual(@as(usize, 3), utf16Length("a\u{1f600}"));
    try testing.expectEqual(@as(usize, 3), utf16Length("a\u{e9}\u{4e2d}"));
    // A lone high surrogate, U+D800, then U+DFFF: both one unit.
    try testing.expectEqual(@as(usize, 2), utf16Length("\xed\xa0\x80\xed\xbf\xbf"));
    try testing.expectEqual(std.math.Order.lt, compare("\xed\xa0\x80", "\u{e000}"));
}

test "JSON.stringify of a string" {
    var buf: [64]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try writeJsonString(&w, "a\"\\\n\x01\xed\xa0\x80\u{e9}");
    try testing.expectEqualStrings("\"a\\\"\\\\\\n\\u0001\\ud800\u{e9}\"", w.buffered());
}
