//! The project `.env` (`src/cli/env-file.ts`). `stator build` runs in a directory whose files the
//! user may not have written, so the file may choose among Stator's own build options, never the
//! programs Stator runs or where its telemetry goes: `CC`, `STATOR_RUNTIME_ROOT` and every `OTEL_*`
//! variable come from the real environment only.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const fspath = std.fs.path;
const oom = @import("failure.zig").oom;
const config = @import("config.zig");
const names = @import("../support/names.zig");

pub const keys = [_][]const u8{ "STATOR_OPT", "STATOR_RUNTIME", "STATOR_OTEL" };

fn refused(key: []const u8) bool {
    return std.mem.eql(u8, key, "CC") or std.mem.startsWith(u8, key, "STATOR_") or std.mem.startsWith(u8, key, "OTEL_");
}

pub const Entry = struct { key: []const u8, value: []const u8 };

fn isSpace(c: u8) bool {
    return c == ' ' or (c >= 0x09 and c <= 0x0d);
}

fn isKeyChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_' or c == '.' or c == '-';
}

/// One quoted value starting at `open`: the first quote of its kind that is not escaped closes it.
fn quotedEnd(text: []const u8, open: usize) ?usize {
    const quote = text[open];
    var i = open + 1;
    while (i < text.len) : (i += 1) {
        if (text[i] == '\\' and i + 1 < text.len and text[i + 1] == quote) {
            i += 1;
            continue;
        }
        if (text[i] == quote) return i + 1;
    }
    return null;
}

/// Whether only blanks and a comment follow `at` on its line, which is what lets a quoted value
/// end the regular expression's match at `$`.
fn endsLine(text: []const u8, at: usize) bool {
    var i = at;
    while (i < text.len and isSpace(text[i])) : (i += 1) {
        if (text[i] == '\n') return true;
    }
    if (i >= text.len) return true;
    if (text[i] != '#') return false;
    return true;
}

fn unquoted(a: Allocator, raw: []const u8) []const u8 {
    const value = std.mem.trim(u8, raw, " \t\n\r\x0b\x0c");
    if (value.len >= 2) {
        const q = value[0];
        if ((q == '\'' or q == '"' or q == '`') and value[value.len - 1] == q) {
            const inner = value[1 .. value.len - 1];
            if (q != '"') return inner;
            const newlines = std.mem.replaceOwned(u8, a, inner, "\\n", "\n") catch oom();
            return std.mem.replaceOwned(u8, a, newlines, "\\r", "\r") catch oom();
        }
    }
    return value;
}

/// dotenv 18's `parse`, the regular-expression form. Keys keep the order they first appear in;
/// a repeated key takes the last value.
pub fn parse(a: Allocator, input: []const u8) []const Entry {
    const crlf = std.mem.replaceOwned(u8, a, input, "\r\n", "\n") catch oom();
    const text = std.mem.replaceOwned(u8, a, crlf, "\r", "\n") catch oom();
    var entries: std.ArrayList(Entry) = .empty;
    var line_start: usize = 0;
    while (line_start <= text.len) {
        var i = line_start;
        while (i < text.len and isSpace(text[i])) i += 1;
        if (i >= text.len) break;
        var key_start = i;
        if (std.mem.startsWith(u8, text[i..], "export") and i + 6 < text.len and isSpace(text[i + 6])) {
            var j = i + 6;
            while (j < text.len and isSpace(text[j])) j += 1;
            if (j < text.len and isKeyChar(text[j])) key_start = j;
        }
        var key_end = key_start;
        while (key_end < text.len and isKeyChar(text[key_end])) key_end += 1;
        var after = key_end;
        var matched = false;
        if (key_end > key_start) {
            var j = key_end;
            while (j < text.len and isSpace(text[j])) j += 1;
            if (j < text.len and text[j] == '=') {
                after = j + 1;
                matched = true;
            } else if (key_end < text.len and text[key_end] == ':' and key_end + 1 < text.len and isSpace(text[key_end + 1])) {
                after = key_end + 2;
                matched = true;
            }
        }
        if (!matched) {
            const nl = std.mem.indexOfScalarPos(u8, text, i, '\n') orelse break;
            line_start = nl + 1;
            continue;
        }
        var v = after;
        while (v < text.len and isSpace(text[v])) v += 1;
        var value: []const u8 = "";
        var next: usize = text.len;
        var done = false;
        if (v < text.len and (text[v] == '\'' or text[v] == '"' or text[v] == '`')) {
            if (quotedEnd(text, v)) |end| {
                if (endsLine(text, end)) {
                    value = unquoted(a, text[v..end]);
                    next = std.mem.indexOfScalarPos(u8, text, end, '\n') orelse text.len;
                    done = true;
                }
            }
        }
        if (!done) {
            // The unquoted alternative stops at a comment or the end of the line. It starts where
            // the `=` left off, so a value on the next line belongs to the key only when the `\s*`
            // before the alternatives took the newline.
            var start = after;
            while (start < text.len and (text[start] == ' ' or text[start] == '\t')) start += 1;
            var end = start;
            while (end < text.len and text[end] != '#' and text[end] != '\n') end += 1;
            value = unquoted(a, text[start..end]);
            next = std.mem.indexOfScalarPos(u8, text, end, '\n') orelse text.len;
        }
        config.setKey(Entry, a, &entries, .{ .key = text[key_start..key_end], .value = value });
        line_start = next + 1;
    }
    return entries.items;
}

pub const Result = struct {
    applied: []const []const u8 = &.{},
    ignored: []const []const u8 = &.{},
    warning: ?[]const u8 = null,
};

/// Reads `<dir>/.env` and copies only the allowlisted keys into `env`. A real variable wins.
pub fn apply(a: Allocator, io: Io, dir: []const u8, env: *std.process.Environ.Map) Result {
    const path = fspath.join(a, &.{ dir, ".env" }) catch oom();
    const bytes = Io.Dir.cwd().readFileAlloc(io, path, a, .unlimited) catch |e| switch (e) {
        error.FileNotFound => return .{},
        error.IsDir => return .{ .warning = std.fmt.allocPrint(a, "cannot read {s} (EISDIR: illegal operation on a directory, read); ignored", .{path}) catch oom() },
        error.AccessDenied, error.PermissionDenied => return .{ .warning = std.fmt.allocPrint(a, "cannot read {s} (EACCES: permission denied, open '{s}'); ignored", .{ path, path }) catch oom() },
        error.OutOfMemory => oom(),
        else => return .{ .warning = std.fmt.allocPrint(a, "cannot read {s} ({t}); ignored", .{ path, e }) catch oom() },
    };
    var applied: std.ArrayList([]const u8) = .empty;
    var ignored: std.ArrayList([]const u8) = .empty;
    for (parse(a, config.decodeUtf8(a, bytes))) |entry| {
        if (!names.contains(&keys, entry.key)) {
            if (refused(entry.key)) ignored.append(a, entry.key) catch oom();
            continue;
        }
        if (env.get(entry.key) == null) {
            env.put(entry.key, entry.value) catch oom();
            applied.append(a, entry.key) catch oom();
        }
    }
    return .{ .applied = applied.items, .ignored = ignored.items };
}

/// The one stderr line about the file, or null when there is nothing to say.
pub fn notice(a: Allocator, result: Result) ?[]const u8 {
    if (result.warning) |w| return std.fmt.allocPrint(a, "stator: .env: {s}", .{w}) catch oom();
    var parts: std.ArrayList([]const u8) = .empty;
    if (result.applied.len != 0)
        parts.append(a, std.fmt.allocPrint(a, "applied {s}", .{std.mem.join(a, ", ", result.applied) catch oom()}) catch oom()) catch oom();
    if (result.ignored.len != 0)
        parts.append(a, std.fmt.allocPrint(a, "ignored {s} (only {s} may come from .env)", .{
            std.mem.join(a, ", ", result.ignored) catch oom(),
            std.mem.join(a, ", ", &keys) catch oom(),
        }) catch oom()) catch oom();
    if (parts.items.len == 0) return null;
    return std.fmt.allocPrint(a, "stator: .env: {s}", .{std.mem.join(a, "; ", parts.items) catch oom()}) catch oom();
}

test "values, quotes, comments and export" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const e = parse(arena.allocator(), "# c\nA=1\nexport B = two # note\nC='q # r'\nD=\"x\\ny\"\nE: v\n\nF=\nA=9\n");
    try std.testing.expectEqual(@as(usize, 6), e.len);
    try std.testing.expectEqualStrings("9", e[0].value);
    try std.testing.expectEqualStrings("two", e[1].value);
    try std.testing.expectEqualStrings("q # r", e[2].value);
    try std.testing.expectEqualStrings("x\ny", e[3].value);
    try std.testing.expectEqualStrings("v", e[4].value);
    try std.testing.expectEqualStrings("", e[5].value);
}
