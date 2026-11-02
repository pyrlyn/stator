//! JavaScript's reading of text the compiler is handed as UTF-8: what `\s` matches, a code point at
//! a time.
const std = @import("std");
const unicode = std.unicode;

/// JavaScript's `\s`.
pub fn isSpace(cp: u21) bool {
    return switch (cp) {
        0x09...0x0d, 0x20, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => true,
        else => false,
    };
}

/// Never fails: a sequence that does not decode reads as U+FFFD, as wide as its lead byte claims
/// (cut at the end), and a byte that cannot lead one reads as itself. Neither is a space, which is
/// all a caller asks.
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

test "a malformed sequence is one code point as wide as it claims" {
    var it: CodePoints = .{ .bytes = "a\xe2\x80 \xff" };
    const want = [_]CodePoints.Item{
        .{ .cp = 'a', .start = 0, .end = 1 },
        .{ .cp = 0xFFFD, .start = 1, .end = 4 },
        .{ .cp = 0xff, .start = 4, .end = 5 },
    };
    for (want) |item| try std.testing.expectEqual(item, it.next().?);
    try std.testing.expectEqual(@as(?CodePoints.Item, null), it.next());
    try std.testing.expect(isSpace(0x3000) and !isSpace('a'));
}
