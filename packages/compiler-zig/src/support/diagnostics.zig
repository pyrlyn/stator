//! The diagnostics engine: stable STA codes, spans, mode. `docs/DIAGNOSTICS.md` is the sole
//! allocator of codes; nothing here invents one.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Mode = enum { ts, js };

pub const Class = enum {
    @"error",
    never,
    @"not-yet",
    runtime,
    internal,
};

/// Offset and length in UTF-16 units, as the JSON schema in docs/DIAGNOSTICS.md counts them.
pub const Span = struct { start: u32 = 0, length: u32 = 0 };

/// `phase` is set only on a `not-yet`, and left out of JSON otherwise.
pub const Diagnostic = struct {
    file: []const u8,
    span: Span = .{},
    /// 1-indexed.
    line: u32,
    /// 1-indexed, in UTF-16 units.
    column: u32,
    code: []const u8,
    class: Class,
    mode: Mode,
    message: []const u8,
    phase: ?u32 = null,
};

/// A source position as TypeScript reports one: 1-indexed line, 1-indexed column in UTF-16 units.
pub const Position = struct { line: u32, column: u32, utf16_offset: u32 };

/// `\r`, `\r\n`, U+2028 and U+2029 end a line for the checker, so a line count on `\n` alone would
/// disagree with it on any file that uses them.
pub fn positionOf(src: []const u8, offset: u32) Position {
    const end = @min(offset, src.len);
    var line: u32 = 1;
    var column: u32 = 1;
    var units: u32 = 0;
    var i: usize = 0;
    while (i < end) {
        const b = src[i];
        if (b < 0x80) {
            i += 1;
            units += 1;
            if (b == '\n' or (b == '\r' and !(i < src.len and src[i] == '\n'))) {
                line += 1;
                column = 1;
            } else column += 1;
            continue;
        }
        const len = std.unicode.utf8ByteSequenceLength(b) catch 1;
        const is_separator = len == 3 and i + 2 < src.len and b == 0xE2 and src[i + 1] == 0x80 and (src[i + 2] == 0xA8 or src[i + 2] == 0xA9);
        i += len;
        const width: u32 = if (len == 4) 2 else 1;
        units += width;
        if (is_separator) {
            line += 1;
            column = 1;
        } else column += width;
    }
    return .{ .line = line, .column = column, .utf16_offset = units };
}

/// The span of `[start, end)` in the units the schema counts.
pub fn spanOf(src: []const u8, start: u32, end: u32) Span {
    const from = positionOf(src, start).utf16_offset;
    return .{ .start = from, .length = positionOf(src, end).utf16_offset - from };
}

/// `diagnosticFromNode`, over the byte range a node covers.
pub fn fromRange(file: []const u8, src: []const u8, start: u32, end: u32, code: []const u8, class: Class, mode: Mode, message: []const u8, phase: ?u32) Diagnostic {
    const at = positionOf(src, start);
    return fromFile(file, at.line, at.column, code, class, mode, message, spanOf(src, start, end), phase);
}

/// `diagnosticFromFile`: for load-time errors, where the caller already knows the position.
pub fn fromFile(file: []const u8, line: u32, column: u32, code: []const u8, class: Class, mode: Mode, message: []const u8, span: ?Span, phase: ?u32) Diagnostic {
    return .{
        .file = file,
        .span = span orelse .{},
        .line = line,
        .column = column,
        .code = code,
        .class = class,
        .mode = mode,
        .message = message,
        .phase = if (class == .@"not-yet") phase else null,
    };
}

/// `file:line:col STAxxxx [mode] message`
pub fn render(a: Allocator, d: Diagnostic) Allocator.Error![]u8 {
    return std.fmt.allocPrint(a, "{s}:{d}:{d} {s} [{t}] {s}", .{ d.file, d.line, d.column, d.code, d.mode, d.message });
}

/// `JSON.stringify` of a string, so that explain's output compares byte for byte.
pub const writeJsonString = @import("jstext").writeJsonString;

test "positions count UTF-16 units and every line terminator" {
    const src = "a\r\nb\xF0\x9F\x98\x80c\xE2\x80\xA8d";
    const at_c = positionOf(src, 8);
    try std.testing.expectEqual(@as(u32, 2), at_c.line);
    try std.testing.expectEqual(@as(u32, 4), at_c.column);
    const at_d = positionOf(src, 12);
    try std.testing.expectEqual(@as(u32, 3), at_d.line);
    try std.testing.expectEqual(@as(u32, 1), at_d.column);
}

test "phase survives only on a not-yet" {
    const yes = fromRange("f.ts", "x", 0, 1, "STA1214", .@"not-yet", .ts, "m", 5);
    try std.testing.expectEqual(@as(?u32, 5), yes.phase);
    const no = fromRange("f.ts", "x", 0, 1, "STA1101", .never, .ts, "m", 5);
    try std.testing.expectEqual(@as(?u32, null), no.phase);
}

test "render is the human line" {
    const d = fromFile("f.ts", 2, 3, "STA1002", .never, .ts, "no", null, null);
    const line = try render(std.testing.allocator, d);
    defer std.testing.allocator.free(line);
    try std.testing.expectEqualStrings("f.ts:2:3 STA1002 [ts] no", line);
}
