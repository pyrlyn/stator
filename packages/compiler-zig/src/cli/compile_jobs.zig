//! `STATOR_COMPILE_JOBS` (`src/cli/compile-jobs.ts`). `1` is one translation unit and one clang
//! invocation. Above 1, file-scope functions compile as separate units sharing one header of
//! external declarations. Unset means the host's parallelism, but a small program stays one unit:
//! process startup costs more than it returns until the generated C is large enough.
const std = @import("std");
const Allocator = std.mem.Allocator;
const failure = @import("failure.zig");
const oom = failure.oom;

/// Unset `STATOR_COMPILE_JOBS` splits only at or above both of these.
pub const parallel_min_functions = 8;
pub const parallel_min_chars = 40_000;

pub const Jobs = struct { jobs: usize, explicit: bool };

const max_safe_integer: u64 = 9007199254740991;

fn jsTrim(s: []const u8) []const u8 {
    return std.mem.trim(u8, s, " \t\n\r\x0b\x0c");
}

/// Null means the value is refused; `invalid` then holds the trimmed text.
pub fn resolve(env_value: ?[]const u8, host_jobs: usize, invalid: *[]const u8) ?Jobs {
    const raw = jsTrim(env_value orelse return .{ .jobs = host_jobs, .explicit = false });
    if (raw.len == 0) return .{ .jobs = host_jobs, .explicit = false };
    invalid.* = raw;
    if (raw.len > 1 and raw[0] == '0') return null;
    const jobs = std.fmt.parseInt(u64, raw, 10) catch return null;
    if (raw[0] == '+' or jobs < 1 or jobs > max_safe_integer) return null;
    return .{ .jobs = @intCast(jobs), .explicit = true };
}

const Walked = struct {
    preamble: []const []const u8,
    functions: []const []const []const u8,
};

fn isFunctionOpen(line: []const u8) bool {
    // Column zero is the emitter's layout: only file-scope functions open there. An indented
    // `if (…) {` is a body statement and must not start a unit.
    return std.mem.endsWith(u8, line, " {") and
        std.mem.indexOfScalar(u8, line, '(') != null and
        !std.mem.startsWith(u8, line, "#") and
        !std.mem.startsWith(u8, line, " ") and
        !std.mem.startsWith(u8, line, "\t") and
        !std.mem.startsWith(u8, line, "static const ");
}

/// Every generated function opens at column zero and its closing `}` is the only unindented brace.
/// That is the emitter's layout, not a C parser. A function that never closes is an emitter bug.
fn walk(a: Allocator, c: []const u8) error{Unclosed}!Walked {
    var preamble: std.ArrayList([]const u8) = .empty;
    var functions: std.ArrayList([]const []const u8) = .empty;
    var open: ?std.ArrayList([]const u8) = null;
    var lines = std.mem.splitScalar(u8, c, '\n');
    while (lines.next()) |line| {
        if (open == null) {
            if (isFunctionOpen(line)) {
                open = .empty;
                open.?.append(a, line) catch oom();
            } else preamble.append(a, line) catch oom();
            continue;
        }
        open.?.append(a, line) catch oom();
        if (std.mem.eql(u8, line, "}")) {
            functions.append(a, open.?.items) catch oom();
            open = null;
        }
    }
    if (open != null) return error.Unclosed;
    return .{ .preamble = preamble.items, .functions = functions.items };
}

pub fn countTopLevelFunctions(a: Allocator, c: []const u8) error{Unclosed}!usize {
    return (try walk(a, c)).functions.len;
}

/// `c.length`: the thresholds were tuned on UTF-16 units.
fn utf16Length(s: []const u8) usize {
    var n: usize = 0;
    for (s) |b| {
        if (b & 0xC0 != 0x80) n += if (b >= 0xF0) 2 else 1;
    }
    return n;
}

pub fn shouldSplit(a: Allocator, c: []const u8, jobs: usize, explicit: bool) error{Unclosed}!bool {
    if (jobs < 2) return false;
    const functions = try countTopLevelFunctions(a, c);
    if (functions < 2) return false;
    if (explicit) return true;
    return functions >= parallel_min_functions and utf16Length(c) >= parallel_min_chars;
}

const header_name = "stator_units.h";

pub const Unit = struct { name: []const u8, source: []const u8 };
pub const Partitioned = struct { header_name: []const u8 = header_name, header: []const u8, units: []const Unit };

const PreambleKind = enum { blank, include, globals, prototype, data, other };

/// Index of the ` = ` that starts a file-scope initializer, ignoring one inside a string.
fn initializerAt(line: []const u8) ?usize {
    var quoted = false;
    var i: usize = 0;
    while (i + 2 < line.len) : (i += 1) {
        const ch = line[i];
        if (ch == '\\' and quoted) {
            i += 1;
            continue;
        }
        if (ch == '"') {
            quoted = !quoted;
            continue;
        }
        if (!quoted and std.mem.startsWith(u8, line[i..], " = ")) return i;
    }
    return null;
}

fn isPrototype(line: []const u8) bool {
    return std.mem.endsWith(u8, line, ";") and std.mem.indexOfScalar(u8, line, '(') != null and initializerAt(line) == null;
}

fn globalsSlots(line: []const u8) ?[]const u8 {
    const prefix = "JSRT_GLOBALS(";
    const suffix = ");";
    if (!std.mem.startsWith(u8, line, prefix) or !std.mem.endsWith(u8, line, suffix)) return null;
    if (line.len < prefix.len + suffix.len + 1) return null;
    const digits = line[prefix.len .. line.len - suffix.len];
    for (digits) |d| if (!std.ascii.isDigit(d)) return null;
    return digits;
}

fn classify(line: []const u8) PreambleKind {
    if (std.mem.trim(u8, line, " \t\r\n\x0b\x0c").len == 0) return .blank;
    if (std.mem.startsWith(u8, line, "#include ")) return .include;
    if (globalsSlots(line) != null) return .globals;
    if (std.mem.startsWith(u8, line, "static ") and isPrototype(line)) return .prototype;
    if (std.mem.startsWith(u8, line, "static ")) return .data;
    if (isPrototype(line)) return .prototype;
    return .other;
}

fn dropStatic(line: []const u8) []const u8 {
    return if (std.mem.startsWith(u8, line, "static ")) line["static ".len..] else line;
}

fn asExtern(a: Allocator, bare: []const u8) []const u8 {
    const head = std.mem.trimEnd(u8, if (initializerAt(bare)) |at| bare[0..at] else bare, " \t");
    const decl = if (std.mem.endsWith(u8, head, ";")) head else std.mem.concat(a, u8, &.{ head, ";" }) catch oom();
    return if (std.mem.startsWith(u8, decl, "extern ")) decl else std.mem.concat(a, u8, &.{ "extern ", decl }) catch oom();
}

/// File-scope `static` hides the function from every other unit. The first real line is the
/// signature; a body-local `static` stays.
fn publish(a: Allocator, lines: []const []const u8) []const []const u8 {
    const out = a.alloc([]const u8, lines.len) catch oom();
    var stripped = false;
    for (lines, out) |line, *o| {
        if (stripped or std.mem.startsWith(u8, line, "#line ") or line.len == 0) {
            o.* = line;
            continue;
        }
        stripped = true;
        o.* = dropStatic(line);
    }
    return out;
}

const Ranked = struct { lines: []const []const u8, index: usize };

fn rankedBefore(_: void, l: Ranked, r: Ranked) bool {
    if (l.lines.len != r.lines.len) return l.lines.len > r.lines.len;
    return l.index < r.index;
}

/// Largest functions first, each into the lightest bucket, so `jobs` clang processes get about the
/// same amount of C. Empty buckets are dropped.
fn bucketFunctions(a: Allocator, functions: []const []const []const u8, buckets: usize) []const []const []const u8 {
    const groups = a.alloc(std.ArrayList([]const u8), buckets) catch oom();
    @memset(groups, .empty);
    const weight = a.alloc(usize, buckets) catch oom();
    @memset(weight, 0);
    const ranked = a.alloc(Ranked, functions.len) catch oom();
    for (functions, ranked, 0..) |lines, *r, i| r.* = .{ .lines = lines, .index = i };
    std.mem.sort(Ranked, ranked, {}, rankedBefore);
    for (ranked) |fn_| {
        var best: usize = 0;
        for (1..buckets) |i| {
            if (weight[i] < weight[best]) best = i;
        }
        if (groups[best].items.len > 0) groups[best].append(a, "") catch oom();
        groups[best].appendSlice(a, publish(a, fn_.lines)) catch oom();
        weight[best] += fn_.lines.len;
    }
    var out: std.ArrayList([]const []const u8) = .empty;
    for (groups) |g| {
        if (g.items.len > 0) out.append(a, g.items) catch oom();
    }
    return out.items;
}

/// A shared data unit plus up to `jobs` function units. The caller checked `shouldSplit`.
pub fn partition(a: Allocator, c: []const u8, jobs: usize) error{Unclosed}!Partitioned {
    const walked = try walk(a, c);
    var header: std.ArrayList([]const u8) = .empty;
    var shared: std.ArrayList([]const u8) = .empty;
    header.appendSlice(a, &.{ "#ifndef STATOR_UNITS_H", "#define STATOR_UNITS_H", "" }) catch oom();
    shared.appendSlice(a, &.{ "#include \"" ++ header_name ++ "\"", "" }) catch oom();
    for (walked.preamble) |line| {
        switch (classify(line)) {
            .blank => {},
            .include => header.append(a, line) catch oom(),
            .globals => {
                // The macro defines these `static`. Across units they have to be one object:
                // `JSRT_GLOBAL` in a function unit reads the array `main` fills.
                header.appendSlice(a, &.{ "extern jsrt_value _jsrt_globals[];", "extern JSRTFrame _jsrt_global_frame;" }) catch oom();
                shared.append(a, std.fmt.allocPrint(a, "jsrt_value _jsrt_globals[{s}];", .{globalsSlots(line).?}) catch oom()) catch oom();
                shared.append(a, "JSRTFrame _jsrt_global_frame;") catch oom();
            },
            .prototype => header.append(a, dropStatic(line)) catch oom(),
            .data => {
                const bare = dropStatic(line);
                header.append(a, asExtern(a, bare)) catch oom();
                shared.append(a, bare) catch oom();
            },
            .other => shared.append(a, line) catch oom(),
        }
    }
    const bucket_count = @min(jobs, walked.functions.len);
    var units: std.ArrayList(Unit) = .empty;
    units.append(a, .{
        .name = "stator_shared.c",
        .source = std.mem.concat(a, u8, &.{ std.mem.join(a, "\n", shared.items) catch oom(), "\n" }) catch oom(),
    }) catch oom();
    const buckets = bucketFunctions(a, walked.functions, bucket_count);
    // Every published function needs a prototype in the header: a call from one unit to a function
    // the partition parked in another is otherwise an undeclared identifier.
    for (buckets) |group| {
        for (group) |line| {
            if (isFunctionOpen(line))
                header.append(a, std.mem.concat(a, u8, &.{ line[0 .. line.len - 2], ";" }) catch oom()) catch oom();
        }
    }
    for (buckets, 0..) |lines, index| {
        units.append(a, .{
            .name = std.fmt.allocPrint(a, "stator_unit_{d}.c", .{index}) catch oom(),
            .source = std.fmt.allocPrint(a, "#include \"" ++ header_name ++ "\"\n\n{s}\n", .{std.mem.join(a, "\n", lines) catch oom()}) catch oom(),
        }) catch oom();
    }
    header.appendSlice(a, &.{ "", "#endif /* STATOR_UNITS_H */" }) catch oom();
    return .{ .header = std.mem.concat(a, u8, &.{ std.mem.join(a, "\n", header.items) catch oom(), "\n" }) catch oom(), .units = units.items };
}

test "jobs text" {
    var bad: []const u8 = "";
    try std.testing.expectEqual(@as(usize, 7), resolve(null, 7, &bad).?.jobs);
    try std.testing.expectEqual(false, resolve("  ", 7, &bad).?.explicit);
    try std.testing.expectEqual(@as(usize, 3), resolve(" 3 ", 7, &bad).?.jobs);
    try std.testing.expect(resolve("0", 7, &bad) == null);
    try std.testing.expect(resolve("01", 7, &bad) == null);
    try std.testing.expect(resolve("+2", 7, &bad) == null);
    try std.testing.expect(resolve("x", 7, &bad) == null);
    try std.testing.expectEqualStrings("x", bad);
}

test "a program splits into one shared unit and function units" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const c =
        \\#include "jsrt.h"
        \\
        \\JSRT_GLOBALS(3);
        \\static int f(int x);
        \\static const char s[] = "a = b";
        \\static int f(int x) {
        \\  return x;
        \\}
        \\int main(void) {
        \\  return f(0);
        \\}
        \\
    ;
    try std.testing.expect(try shouldSplit(a, c, 2, true));
    try std.testing.expect(!try shouldSplit(a, c, 2, false));
    const p = try partition(a, c, 2);
    try std.testing.expectEqual(@as(usize, 3), p.units.len);
    try std.testing.expect(std.mem.indexOf(u8, p.header, "extern const char s[];") != null or std.mem.indexOf(u8, p.header, "extern const char s[]") != null);
    try std.testing.expect(std.mem.indexOf(u8, p.units[0].source, "jsrt_value _jsrt_globals[3];") != null);
}

test "a function that never closes is refused" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectError(error.Unclosed, countTopLevelFunctions(arena.allocator(), "int main(void) {\n  x;\n"));
}
