//! JavaScript string semantics over UTF-8. The generated `.d.ts` is compared byte for byte with the
//! TypeScript generator's, and that generator counts in UTF-16 units and spaces in `\s`'s set.
const std = @import("std");
const Allocator = std.mem.Allocator;
const unicode = std.unicode;
const upper_table = @import("upper_table.zig");
const jstext = @import("jstext");
const names = @import("../support/names.zig");

pub fn oom() noreturn {
    @panic("out of memory");
}

pub fn fmt(a: Allocator, comptime format: []const u8, args: anytype) []const u8 {
    return std.fmt.allocPrint(a, format, args) catch oom();
}

/// A `Buffer.toString('utf8')`: the header and clang's streams may hold bytes that are not UTF-8,
/// and every later step reads the replaced text.
pub fn lossyUtf8(a: Allocator, bytes: []const u8) []const u8 {
    if (unicode.utf8ValidateSlice(bytes)) return bytes;
    return std.fmt.allocPrint(a, "{f}", .{unicode.fmtUtf8(bytes)}) catch oom();
}

const codepointAt = jstext.codePointAt;
pub const spaceAt = jstext.spaceAt;
pub const skipSpaces = jstext.skipSpaces;
pub const trimStart = jstext.trimStart;
pub const skipSpacesBack = jstext.skipSpacesBack;
pub const trim = jstext.trim;

/// `text.trim().replace(/\s+/g, ' ')`.
pub fn collapseSpaces(a: Allocator, text: []const u8) []const u8 {
    const body = trim(text);
    var out: std.ArrayList(u8) = .empty;
    out.ensureTotalCapacity(a, body.len) catch oom();
    var i: usize = 0;
    while (i < body.len) {
        if (spaceAt(body, i) != 0) {
            i = skipSpaces(body, i);
            out.appendAssumeCapacity(' ');
        } else {
            out.appendAssumeCapacity(body[i]);
            i += 1;
        }
    }
    return out.items;
}

pub const isWordByte = names.isWordByte;
pub const isIdentifierStart = names.isIdentifierStart;
pub const isCIdentifier = names.isCIdentifier;

/// The end of the `[A-Za-z_][A-Za-z0-9_]*` at `at`, or null.
pub fn identifierEnd(s: []const u8, at: usize) ?usize {
    if (at >= s.len or !isIdentifierStart(s[at])) return null;
    var end = at + 1;
    while (end < s.len and isWordByte(s[end])) end += 1;
    return end;
}

fn wordAt(s: []const u8, at: usize, len: usize) bool {
    const before = at == 0 or !isWordByte(s[at - 1]);
    const after = at + len == s.len or !isWordByte(s[at + len]);
    return before and after;
}

/// `/\bword\b/.test(s)`: `\b` sees only ASCII word characters without the `u` flag.
pub fn hasWord(s: []const u8, word: []const u8) bool {
    var from: usize = 0;
    while (std.mem.indexOfPos(u8, s, from, word)) |at| {
        if (wordAt(s, at, word.len)) return true;
        from = at + 1;
    }
    return false;
}

/// `s.replace(/\bword\b/g, ' ')`.
pub fn blankWord(a: Allocator, s: []const u8, word: []const u8) []const u8 {
    if (!hasWord(s, word)) return s;
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        if (std.mem.startsWith(u8, s[i..], word) and wordAt(s, i, word.len)) {
            out.append(a, ' ') catch oom();
            i += word.len;
        } else {
            out.append(a, s[i]) catch oom();
            i += 1;
        }
    }
    return out.items;
}

/// JavaScript's `<` on strings, which compares UTF-16 units and so orders an astral letter before
/// U+E000.
pub const lessUtf16 = jstext.less;

pub fn lessString(_: void, x: []const u8, y: []const u8) bool {
    return lessUtf16(x, y);
}

/// `.length`.
pub const utf16Length = jstext.utf16Length;

fn upperOf(a: Allocator, cp: u21) ?[]const u8 {
    if (cp > 0xffff) return null;
    const unit: u16 = @intCast(cp);
    for (upper_table.special) |row| if (row.unit == unit) return row.upper;
    for (upper_table.ranges) |r| {
        if (unit < r.from or unit > r.to or (unit - r.from) % r.stride != 0) continue;
        const mapped: u21 = @intCast(@as(i32, unit) + r.delta);
        var buf: [4]u8 = undefined;
        const len = unicode.utf8Encode(mapped, &buf) catch return null;
        return a.dupe(u8, buf[0..len]) catch oom();
    }
    return null;
}

/// `part.slice(0, 1).toUpperCase() + part.slice(1)`. `slice(0, 1)` of an astral letter is half of
/// it, which has no case, so those stay as they are.
pub fn upperFirst(a: Allocator, part: []const u8) []const u8 {
    if (part.len == 0) return part;
    if (part[0] < 0x80) {
        if (!std.ascii.isLower(part[0])) return part;
        const out = a.dupe(u8, part) catch oom();
        out[0] = std.ascii.toUpper(part[0]);
        return out;
    }
    const at = codepointAt(part, 0) orelse return part;
    const upper = upperOf(a, at.cp) orelse return part;
    return std.mem.concat(a, u8, &.{ upper, part[at.len..] }) catch oom();
}

const testing = std.testing;

test "the \\s set, not ASCII's" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqualStrings("a b c", collapseSpaces(arena.allocator(), " \u{a0}a \t\nb\u{2003}c\u{feff}\r"));
    try testing.expectEqualStrings("", trim(" \u{3000}\t"));
}

test "word boundaries are ASCII" {
    try testing.expect(hasWord("const int", "const"));
    try testing.expect(hasWord("é const é", "const"));
    try testing.expect(hasWord("éconsté", "const"));
    try testing.expect(!hasWord("constant", "const"));
    try testing.expect(!hasWord("my_const", "const"));
}

test "JavaScript's order and length" {
    try testing.expect(lessUtf16("a", "b"));
    try testing.expect(lessUtf16("a", "ab"));
    try testing.expect(!lessUtf16("a", "a"));
    try testing.expect(lessUtf16("\u{10000}", "\u{e000}"));
    try testing.expect(!lessUtf16("\u{e000}", "\u{10000}"));
    try testing.expectEqual(@as(usize, 3), utf16Length("a\u{1f600}"));
}

test "uppercase follows toUpperCase, not ASCII" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("Abc", upperFirst(a, "abc"));
    try testing.expectEqualStrings("Éa", upperFirst(a, "éa"));
    try testing.expectEqualStrings("SSx", upperFirst(a, "ßx"));
    try testing.expectEqualStrings("Āb", upperFirst(a, "āb"));
    try testing.expectEqualStrings("\u{10428}x", upperFirst(a, "\u{10428}x"));
    try testing.expectEqualStrings("Ā", upperFirst(a, "Ā"));
}

test "bytes that are not UTF-8 read as U+FFFD" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqualStrings("a\u{fffd}b", lossyUtf8(arena.allocator(), "a\xffb"));
}
