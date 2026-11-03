//! What `ts.getJSDocTags` tells `ffi-gen`: which comment attaches to a declaration and what follows
//! `@statorExtern` in it. stator-ts parses no JSDoc, so this walks the text the way the pinned
//! `typescript` scanner does. Every tag reads as an unknown tag: a word is all `readHandwritten`
//! keeps, and the margin arithmetic of tag comments moves only whitespace.
const std = @import("std");
const Allocator = std.mem.Allocator;
pub const text = @import("text.zig");
const oom = text.oom;

fn lineEnd(s: []const u8, from: usize) usize {
    return std.mem.indexOfAnyPos(u8, s, from, "\r\n") orelse s.len;
}

/// The body of the last JSDoc comment in the trivia from `pos` (`getLeadingCommentRanges`). Past
/// the start of a file, what shares a line with the token before is that token's trailing comment.
pub fn lastJsdoc(s: []const u8, pos: usize, node_end: usize) ?[]const u8 {
    var i = pos;
    var collecting = pos == 0;
    if (pos == 0 and std.mem.startsWith(u8, s, "#!")) i = lineEnd(s, 0);
    var found: ?[]const u8 = null;
    while (i < s.len) {
        switch (s[i]) {
            '\r', '\n' => {
                i += 1;
                collecting = true;
            },
            '/' => {
                const start = i;
                const next = if (i + 1 < s.len) s[i + 1] else 0;
                if (next == '/') {
                    i = lineEnd(s, i);
                    continue;
                }
                if (next != '*') return found;
                const close = std.mem.indexOfPos(u8, s, i + 2, "*/");
                i = if (close) |at| at + 2 else s.len;
                if (collecting and i <= node_end and close != null and i - start >= 5 and s[start + 2] == '*' and s[start + 3] != '/')
                    found = s[start + 3 .. i - 2];
            },
            else => {
                const space = text.spaceAt(s, i);
                if (space == 0) return found;
                i += space;
            },
        }
    }
    return found;
}

const State = enum { line_start, saw_asterisk, saving, backticks };

const Walker = struct {
    s: []const u8,
    i: usize = 0,

    /// Where a text token stops. `@` ends one only after a blank and before a word, so `a@b` and a
    /// mail address stay text.
    fn textEnd(w: *const Walker, backticks: bool) usize {
        const s = w.s;
        var at = w.i;
        while (at < s.len) : (at += 1) {
            const b = s[at];
            if (b == '\n' or b == '\r' or b == '`') break;
            if (backticks) continue;
            if (b == '{') break;
            if (b == '@' and text.skipSpacesBack(s, at) != at and text.spaceAt(s, at + 1) == 0) break;
        }
        return at;
    }

    /// There are no Unicode identifier tables here or in stator-ts, so anything past ASCII is a
    /// letter, except what lossy decoding left: that is where bytes that are no text show up.
    fn wordEnd(w: *const Walker, from: usize) usize {
        const s = w.s;
        if (from >= s.len or !isNameStart(s, from)) return from;
        var at = from + 1;
        while (at < s.len and (isNameStart(s, at) or std.ascii.isDigit(s[at]) or s[at] == '-')) at += 1;
        return at;
    }

    /// `{@link x}` and its kin make a tag's comment a node list, not a string; joined, a link reads
    /// as its source text.
    fn linkEnd(w: *const Walker) ?usize {
        const s = w.s;
        if (w.i + 1 >= s.len or s[w.i + 1] != '@') return null;
        const word = s[w.i + 2 .. w.wordEnd(w.i + 2)];
        for ([_][]const u8{ "link", "linkcode", "linkplain" }) |kind| {
            if (!std.mem.eql(u8, word, kind)) continue;
            return @min(s.len, (std.mem.indexOfAnyPos(u8, s, w.i, "}\r\n") orelse s.len) + 1);
        }
        return null;
    }

    /// One comment section: stops on a tag's `@` or at the end. Backticks hide `@` only inside a
    /// tag's comment; the description has no such state.
    fn untilTag(w: *Walker, a: Allocator, start: State, in_tag: bool, out: *std.ArrayList(u8), link: *bool) void {
        const s = w.s;
        var state = start;
        while (w.i < s.len) {
            const b = s[w.i];
            if (b == '\n' or b == '\r') {
                out.append(a, '\n') catch oom();
                w.i += 1;
                state = .line_start;
                continue;
            }
            if (b == '{' and state != .backticks) {
                if (w.linkEnd()) |end| {
                    link.* = true;
                    out.appendSlice(a, s[w.i..end]) catch oom();
                    w.i = end;
                    state = .saving;
                    continue;
                }
            }
            if (state == .line_start or state == .saw_asterisk) {
                const space = text.spaceAt(s, w.i);
                if (space != 0) {
                    w.i += space;
                    continue;
                }
                if (b == '@') return;
                if (b == '*' and state == .line_start) {
                    w.i += 1;
                    state = .saw_asterisk;
                    continue;
                }
                state = .saving;
            }
            const end = w.textEnd(state == .backticks);
            if (end != w.i) {
                out.appendSlice(a, s[w.i..end]) catch oom();
                w.i = end;
                continue;
            }
            switch (b) {
                '@' => return,
                '`' => if (in_tag) {
                    state = if (state == .backticks) .saving else .backticks;
                },
                else => {},
            }
            out.append(a, b) catch oom();
            w.i += 1;
        }
    }

    /// `skipWhitespaceOrAsterisk`: an asterisk counts only as the first thing on a line.
    fn skipTagGap(w: *Walker) void {
        const s = w.s;
        var fresh = false;
        while (w.i < s.len) {
            const b = s[w.i];
            if (b == '\n' or b == '\r') {
                fresh = true;
                w.i += 1;
            } else if (b == '*' and fresh) {
                fresh = false;
                w.i += 1;
            } else {
                const space = text.spaceAt(s, w.i);
                if (space == 0) return;
                w.i += space;
            }
        }
    }
};

fn isNameStart(s: []const u8, at: usize) bool {
    const b = s[at];
    if (b < 0x80) return text.isIdentifierStart(b) or b == '$';
    return text.spaceAt(s, at) == 0 and !std.mem.startsWith(u8, s[at..], "\u{fffd}");
}

pub const Marker = union(enum) {
    /// No `@statorExtern` in the comment.
    none,
    /// The tag, and the first word of its comment: none when the comment is empty or holds a link.
    tag: ?[]const u8,
};

/// `comment?.trim().split(/\s+/, 1)[0]`.
pub fn firstWord(comment: []const u8) ?[]const u8 {
    const body = text.trim(comment);
    if (body.len == 0) return null;
    var end: usize = 0;
    while (end < body.len and text.spaceAt(body, end) == 0) end += 1;
    return body[0..end];
}

pub const Tag = struct {
    name: []const u8,
    /// The comment's parts joined, the way `jsdocText` joins them.
    comment: []const u8,
    /// The comment holds a `{@link}`, so `typeof tag.comment` is not `'string'`.
    link: bool,
};

/// `ts.getJSDocTags` of a JSDoc body, in order.
pub fn tags(a: Allocator, body: []const u8) []const Tag {
    var w: Walker = .{ .s = body };
    var found: std.ArrayList(Tag) = .empty;
    var scratch: std.ArrayList(u8) = .empty;
    var link = false;
    w.untilTag(a, .saw_asterisk, false, &scratch, &link);
    while (w.i < body.len) {
        const name_start = w.i + 1;
        w.i = w.wordEnd(name_start);
        const name = body[name_start..w.i];
        w.skipTagGap();
        scratch = .empty;
        link = false;
        w.untilTag(a, .saw_asterisk, true, &scratch, &link);
        found.append(a, .{ .name = name, .comment = scratch.items, .link = link }) catch oom();
    }
    return found.items;
}

/// The first `@statorExtern` of a JSDoc body.
pub fn externMarker(a: Allocator, body: []const u8) Marker {
    for (tags(a, body)) |tag| {
        if (std.mem.eql(u8, tag.name, "statorExtern")) return .{ .tag = if (tag.link) null else firstWord(tag.comment) };
    }
    return .none;
}

/// Where the trivia in front of the token at `start` begins: the end of the token before it, as
/// far as text can tell without a scanner. A line holding only a `//` comment is trivia.
fn triviaStart(s: []const u8, start: usize) usize {
    var at = @min(start, s.len);
    while (true) {
        at = text.skipSpacesBack(s, at);
        if (at >= 2 and s[at - 2] == '*' and s[at - 1] == '/') {
            at = std.mem.lastIndexOf(u8, s[0 .. at - 2], "/*") orelse return at;
            continue;
        }
        const line = if (std.mem.lastIndexOfScalar(u8, s[0..at], '\n')) |nl| nl + 1 else 0;
        const comment = std.mem.indexOf(u8, s[line..at], "//") orelse return at;
        if (text.trim(s[line .. line + comment]).len != 0) return at;
        at = line;
    }
}

/// `lastJsdoc` for a node whose full start the caller does not have.
pub fn jsdocBefore(s: []const u8, start: usize) ?[]const u8 {
    return lastJsdoc(s, triviaStart(s, start), start);
}

const testing = std.testing;

fn wordOf(a: Allocator, body: []const u8) ?[]const u8 {
    return switch (externMarker(a, body)) {
        .none => "<none>",
        .tag => |word| word,
    };
}

test "the last comment attaches, and one on the token's line trails it" {
    const src = "declare const a: 1; /** @statorExtern no */\n/** first */ // x\n/** second */\nf";
    const at = std.mem.indexOfScalar(u8, src, ';').? + 1;
    try testing.expectEqualStrings(" second ", lastJsdoc(src, at, src.len).?);
    try testing.expectEqual(@as(?[]const u8, null), lastJsdoc("/**/\nf", 0, 6));
    try testing.expectEqualStrings("", lastJsdoc("/***/\nf", 0, 7).?);
    try testing.expectEqualStrings(" a ", lastJsdoc("#!/bin/x\n/** a */ f", 0, 19).?);
    try testing.expectEqual(@as(?[]const u8, null), lastJsdoc("/** open", 0, 8));
}

test "from the token alone, the comment before it still attaches" {
    const src = "a; /** trailing */\n// line\n/** one */ /* two */\n  f";
    try testing.expectEqualStrings(" one ", jsdocBefore(src, src.len - 1).?);
    try testing.expectEqual(@as(?[]const u8, null), jsdocBefore("a; /** same line */ f", 20));
    try testing.expectEqualStrings(" top ", jsdocBefore("/** top */ f", 11).?);
}

test "every tag, with its comment" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const found = tags(arena.allocator(), " Words.\n * @statorExtern c_f\n * @statorError {@link e} x\n ");
    try testing.expectEqual(@as(usize, 2), found.len);
    try testing.expectEqualStrings("statorExtern", found[0].name);
    try testing.expectEqualStrings("c_f", firstWord(found[0].comment).?);
    try testing.expect(!found[0].link);
    try testing.expectEqualStrings("{@link e} x", text.trim(found[1].comment));
    try testing.expect(found[1].link);
}

test "the first word of the first tag" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("sqrt", wordOf(a, " @statorExtern sqrt ").?);
    try testing.expectEqualStrings("a@b", wordOf(a, " @statorExtern a@b c ").?);
    try testing.expectEqualStrings("next", wordOf(a, "\n * Words.\n * @statorExtern\n * next line\n ").?);
    try testing.expectEqualStrings("x", wordOf(a, " @param p @statorExtern x @other y ").?);
    try testing.expectEqualStrings("<none>", wordOf(a, " mail me@statorExtern ").?);
    try testing.expectEqualStrings("<none>", wordOf(a, " @statorExtern-x y ").?);
    try testing.expectEqualStrings("<none>", wordOf(a, " @statorExternñ y ").?);
    try testing.expectEqualStrings("\u{fffd}", wordOf(a, " @statorExtern\u{fffd} y ").?);
    try testing.expectEqual(@as(?[]const u8, null), wordOf(a, " @statorExtern "));
    try testing.expectEqual(@as(?[]const u8, null), wordOf(a, " @statorExtern @other x"));
    try testing.expectEqual(@as(?[]const u8, null), wordOf(a, " @statorExtern x {@link y} z"));
    try testing.expectEqualStrings("`@b`", wordOf(a, " @statorExtern `@b` c").?);
    try testing.expectEqualStrings("{x}", wordOf(a, " @statorExtern {x}").?);
}
