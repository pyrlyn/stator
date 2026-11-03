//! What ink does to a line a human reads (`src/cli/render.ts`): lines wrap at the terminal width,
//! on a pipe too, with the fallback of 80 columns, so a long diagnostic breaks in the same place
//! whether or not ink is in the process. The wrap is wrap-ansi 10 with `trim: false, hard: true`,
//! and ink then drops the spaces a row ends with.
const std = @import("std");
const Allocator = std.mem.Allocator;
const oom = @import("failure.zig").oom;

pub const Color = enum {
    red,
    yellow,
    green,
    cyan,
    gray,

    fn open(c: Color) []const u8 {
        return switch (c) {
            .red => "\x1b[31m",
            .yellow => "\x1b[33m",
            .green => "\x1b[32m",
            .cyan => "\x1b[36m",
            .gray => "\x1b[90m",
        };
    }
};

pub const Line = struct { text: []const u8, color: ?Color = null };

const close_color = "\x1b[39m";

/// East Asian Wide and Fullwidth blocks, emoji included. Scripts outside these count one column;
/// wrap-ansi's grapheme and RGI-emoji rules differ from this only inside a cluster.
fn isWide(cp: u21) bool {
    return switch (cp) {
        0x1100...0x115F, 0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xA000...0xA4CF, 0xAC00...0xD7A3 => true,
        0xF900...0xFAFF, 0xFE30...0xFE6F, 0xFF00...0xFF60, 0xFFE0...0xFFE6, 0x1F300...0x1F64F, 0x1F900...0x1F9FF, 0x20000...0x3FFFD => true,
        else => false,
    };
}

fn isZeroWidth(cp: u21) bool {
    return switch (cp) {
        0...0x1F, 0x7F...0x9F, 0x300...0x36F, 0x200B...0x200F, 0xFE00...0xFE0F, 0xFEFF => true,
        else => false,
    };
}

fn cpWidth(cp: u21) usize {
    if (isZeroWidth(cp)) return 0;
    return if (isWide(cp)) 2 else 1;
}

const Glyph = struct { len: usize, width: usize };

/// A malformed byte counts as one column: text from a path need not be UTF-8.
fn glyphAt(s: []const u8, i: usize) Glyph {
    const len = std.unicode.utf8ByteSequenceLength(s[i]) catch return .{ .len = 1, .width = 1 };
    if (i + len > s.len) return .{ .len = 1, .width = 1 };
    const cp = std.unicode.utf8Decode(s[i .. i + len]) catch return .{ .len = 1, .width = 1 };
    return .{ .len = len, .width = cpWidth(cp) };
}

pub fn displayWidth(s: []const u8) usize {
    var width: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const g = glyphAt(s, i);
        width += g.width;
        i += g.len;
    }
    return width;
}

fn expandTabs(a: Allocator, line: []const u8) []const u8 {
    if (std.mem.indexOfScalar(u8, line, '\t') == null) return line;
    var out: std.ArrayList(u8) = .empty;
    var visible: usize = 0;
    var parts = std.mem.splitScalar(u8, line, '\t');
    var first = true;
    while (parts.next()) |part| {
        if (!first) {
            const spaces = 8 - (visible % 8);
            out.appendNTimes(a, ' ', spaces) catch oom();
            visible += spaces;
        }
        first = false;
        out.appendSlice(a, part) catch oom();
        visible += displayWidth(part);
    }
    return out.items;
}

const Rows = struct {
    a: Allocator,
    rows: std.ArrayList(std.ArrayList(u8)) = .empty,

    fn push(self: *Rows) void {
        self.rows.append(self.a, .empty) catch oom();
    }

    fn last(self: *Rows) *std.ArrayList(u8) {
        return &self.rows.items[self.rows.items.len - 1];
    }

    fn append(self: *Rows, s: []const u8) void {
        self.last().appendSlice(self.a, s) catch oom();
    }
};

fn wrapWord(rows: *Rows, word: []const u8, columns: usize, row_width: usize) usize {
    var visible = row_width;
    var i: usize = 0;
    while (i < word.len) {
        const g = glyphAt(word, i);
        if (g.width > 0 and visible > 0 and visible + g.width > columns) {
            rows.push();
            visible = 0;
        }
        rows.append(word[i .. i + g.len]);
        visible += g.width;
        i += g.len;
        if (visible == columns and i < word.len) {
            rows.push();
            visible = 0;
        }
    }
    return displayWidth(rows.last().items);
}

/// wrap-ansi's `exec`: spaces separate words, and a word wider than the terminal breaks at the
/// column instead of overflowing.
fn wrapLine(a: Allocator, line: []const u8, columns: usize, out: *std.ArrayList([]const u8)) void {
    var rows: Rows = .{ .a = a };
    rows.push();
    var row_length: usize = 0;
    var first = true;
    var words = std.mem.splitScalar(u8, line, ' ');
    while (words.next()) |word| {
        if (first) {
            first = false;
        } else {
            if (row_length >= columns) {
                rows.push();
                row_length = 0;
            }
            rows.append(" ");
            row_length += 1;
        }
        const width = displayWidth(word);
        if (width > columns) {
            const remaining: i64 = @as(i64, @intCast(columns)) - @as(i64, @intCast(row_length));
            const w: i64 = @intCast(width);
            const c: i64 = @intCast(columns);
            const this_line = 1 + @divFloor(w - remaining - 1, c);
            const next_line = @divFloor(w - 1, c);
            if (next_line < this_line) {
                rows.push();
                row_length = 0;
            }
            row_length = wrapWord(&rows, word, columns, row_length);
            continue;
        }
        if (row_length + width > columns and row_length > 0 and width > 0) {
            rows.push();
            row_length = 0;
        }
        rows.append(word);
        row_length += width;
    }
    for (rows.rows.items) |row| out.append(a, row.items) catch oom();
}

/// The rows `text` occupies at `columns`. ink trims the end of every row after layout, which is
/// what removes the separating space a broken line would otherwise end with.
pub fn layout(a: Allocator, text: []const u8, columns: usize) []const []const u8 {
    var rows: std.ArrayList([]const u8) = .empty;
    const unified = std.mem.replaceOwned(u8, a, text, "\r\n", "\n") catch oom();
    var lines = std.mem.splitScalar(u8, unified, '\n');
    while (lines.next()) |raw| {
        const line = expandTabs(a, raw);
        if (displayWidth(line) > columns)
            wrapLine(a, line, columns, &rows)
        else
            rows.append(a, line) catch oom();
    }
    for (rows.items) |*row| row.* = std.mem.trimEnd(u8, row.*, " \t");
    return rows.items;
}

/// `print`: colors only reach a terminal, so a byte comparison over a pipe never sees one.
pub fn render(a: Allocator, lines: []const Line, columns: usize, colored: bool) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (lines) |line| {
        for (layout(a, line.text, columns)) |row| {
            const color = if (colored and row.len != 0) line.color else null;
            if (color) |c| out.appendSlice(a, c.open()) catch oom();
            out.appendSlice(a, row) catch oom();
            if (color != null) out.appendSlice(a, close_color) catch oom();
            out.append(a, '\n') catch oom();
        }
    }
    return out.items;
}

/// `parseInt`: the digits a value starts with, so that `80x` is 80.
fn leadingInteger(text: []const u8) i64 {
    const trimmed = std.mem.trimStart(u8, text, " \t\r\n");
    const digits = if (trimmed.len > 0 and (trimmed[0] == '+' or trimmed[0] == '-')) trimmed[1..] else trimmed;
    var end: usize = 0;
    while (end < digits.len and std.ascii.isDigit(digits[end])) end += 1;
    const value = std.fmt.parseInt(i64, digits[0..end], 10) catch return 0;
    return if (trimmed.len > 0 and trimmed[0] == '-') -value else value;
}

/// `columns` is the width the stream reports, 0 for a pipe. Then ink's fallback: `COLUMNS` with
/// `LINES`, where a bad width is 80 and not a reason to look further, the controlling terminal,
/// and `tput cols`, which answers from `COLUMNS` alone and needs no process to say so.
pub fn terminalColumns(stream_columns: usize, env_columns: ?[]const u8, env_lines: ?[]const u8, tty_columns: usize) usize {
    if (stream_columns > 0) return stream_columns;
    const columns: []const u8 = env_columns orelse "";
    const lines: []const u8 = env_lines orelse "";
    if (columns.len > 0 and lines.len > 0) {
        const width = leadingInteger(columns);
        return if (width > 0) @intCast(width) else 80;
    }
    if (tty_columns > 0) return tty_columns;
    return if (std.fmt.parseInt(usize, columns, 10)) |width| (if (width > 0) width else 80) else |_| 80;
}

test "the environment's width" {
    try std.testing.expectEqual(@as(usize, 20), terminalColumns(0, "20", null, 0));
    try std.testing.expectEqual(@as(usize, 100), terminalColumns(0, "20", null, 100));
    try std.testing.expectEqual(@as(usize, 20), terminalColumns(0, "20x", "24", 100));
    try std.testing.expectEqual(@as(usize, 80), terminalColumns(0, "x", "24", 100));
    try std.testing.expectEqual(@as(usize, 80), terminalColumns(0, "20x", null, 0));
    try std.testing.expectEqual(@as(usize, 50), terminalColumns(50, "20", "24", 100));
}

test "a long line breaks where wrap-ansi breaks it" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const rows = layout(arena.allocator(), "stator: STA0004 --emit=lib requires --emit-header=<h> (config \"emitHeader\"): the header is the library's C surface", 80);
    try std.testing.expectEqual(@as(usize, 2), rows.len);
    try std.testing.expectEqualStrings("stator: STA0004 --emit=lib requires --emit-header=<h> (config \"emitHeader\"): the", rows[0]);
    try std.testing.expectEqualStrings(" header is the library's C surface", rows[1]);
}

test "a separating space does not end a row" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const rows = layout(arena.allocator(), "stator: STA0019 cannot write -o \"/nonexistent/dir/foo/bar/baz/app\": ENOENT (the directory does not exist)", 80);
    try std.testing.expectEqualStrings("stator: STA0019 cannot write -o \"/nonexistent/dir/foo/bar/baz/app\": ENOENT (the", rows[0]);
    try std.testing.expectEqualStrings("directory does not exist)", rows[1]);
}

test "a word wider than the terminal breaks at the column" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const rows = layout(arena.allocator(), "ab cdefghijkl", 5);
    try std.testing.expectEqualStrings("ab", rows[0]);
    try std.testing.expectEqualStrings("cdefg", rows[1]);
    try std.testing.expectEqualStrings("hijkl", rows[2]);
}

test "blank lines stay" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqualStrings("a\n\nb\n", render(arena.allocator(), &.{.{ .text = "a\n\nb" }}, 80, false));
}
