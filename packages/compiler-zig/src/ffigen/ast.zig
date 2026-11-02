//! Clang's JSON AST (`clang -Xclang -ast-dump=json`, `ffi-gen/ast.ts`). Everything in the dump is
//! read through these accessors, which answer null for a field of the wrong shape.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const text = @import("text.zig");
const oom = text.oom;

pub const Json = std.json.Value;

pub fn isObject(value: Json) bool {
    return value == .object;
}

fn fieldOf(node: Json, key: []const u8) ?Json {
    if (node != .object) return null;
    return node.object.get(key);
}

pub fn strField(node: Json, key: []const u8) ?[]const u8 {
    const value = fieldOf(node, key) orelse return null;
    return if (value == .string) value.string else null;
}

pub fn boolField(node: Json, key: []const u8) ?bool {
    const value = fieldOf(node, key) orelse return null;
    return if (value == .bool) value.bool else null;
}

/// The `inner` list; callers skip what is not an object, as `nodeChildren`'s filter does.
pub fn nodeChildren(node: Json) []const Json {
    const inner = fieldOf(node, "inner") orelse return &.{};
    return if (inner == .array) inner.array.items else &.{};
}

/// A JSON number that is a whole number a `u32` holds. Clang's line numbers and offsets are; a
/// larger one is no position in a header.
fn wholeNumber(value: Json) ?u32 {
    const whole: i64 = switch (value) {
        .integer => |i| i,
        .float => |f| if (f == @trunc(f) and @abs(f) < 1e18) @intFromFloat(f) else return null,
        else => return null,
    };
    return std.math.cast(u32, whole);
}

pub const Loc = struct { file: ?[]const u8, line: u32 };

pub fn nodeLoc(node: Json) Loc {
    const loc = fieldOf(node, "loc") orelse return .{ .file = null, .line = 0 };
    if (loc != .object) return .{ .file = null, .line = 0 };
    const raw = fieldOf(loc, "line");
    return .{ .file = strField(loc, "file"), .line = if (raw) |value| wholeNumber(value) orelse 0 else 0 };
}

pub fn nodeOffset(node: Json) ?u32 {
    const loc = fieldOf(node, "loc") orelse return null;
    return wholeNumber(fieldOf(loc, "offset") orelse return null);
}

pub fn nodeQualType(node: Json) ?[]const u8 {
    return strField(fieldOf(node, "type") orelse return null, "qualType");
}

/// The `ownedTagDecl.id` linking a typedef to its anonymous struct, union or enum.
pub fn typedefOwnedTagId(node: Json) ?[]const u8 {
    for (nodeChildren(node)) |child| {
        if (child != .object) continue;
        const kind = strField(child, "kind") orelse continue;
        if (!std.mem.eql(u8, kind, "ElaboratedType")) continue;
        const owned = fieldOf(child, "ownedTagDecl") orelse continue;
        if (owned == .object) return strField(owned, "id");
    }
    return null;
}

pub const Dump = union(enum) {
    root: Json,
    /// The line `main.ts` prints before it exits 1.
    failed: []const u8,
};

fn errnoName(err: anyerror) []const u8 {
    return switch (err) {
        error.FileNotFound => "ENOENT",
        error.AccessDenied, error.PermissionDenied => "EACCES",
        error.NotDir => "ENOTDIR",
        error.IsDir => "EISDIR",
        error.InvalidExe => "ENOEXEC",
        error.NameTooLong => "ENAMETOOLONG",
        error.SymLinkLoop => "ELOOP",
        else => @errorName(err),
    };
}

/// `run.stderr.trim().split('\n').slice(0, 5).join('\n')`.
fn firstLines(a: Allocator, stderr: []const u8) []const u8 {
    const body = text.trim(text.lossyUtf8(a, stderr));
    var end: usize = 0;
    var left: usize = 5;
    while (left > 0) : (left -= 1) {
        const newline = std.mem.indexOfScalarPos(u8, body, end, '\n') orelse return body;
        if (left == 1) return body[0..newline];
        end = newline + 1;
    }
    return body;
}

/// `spawnSync`'s `maxBuffer`. Past it Node kills clang, and so does `std.process.run`.
const max_buffer = 256 * 1024 * 1024;

pub fn runClangAstDump(a: Allocator, io: Io, clang: []const u8, header: []const u8, extra: []const []const u8) Dump {
    var argv: std.ArrayList([]const u8) = .empty;
    argv.appendSlice(a, &.{ clang, "-Xclang", "-ast-dump=json", "-fsyntax-only" }) catch oom();
    argv.appendSlice(a, extra) catch oom();
    argv.append(a, header) catch oom();
    const run = std.process.run(a, io, .{
        .argv = argv.items,
        .stdout_limit = .limited(max_buffer),
        .stderr_limit = .limited(max_buffer),
    }) catch |err| {
        const code = if (err == error.StreamTooLong) "ENOBUFS" else errnoName(err);
        return .{ .failed = std.fmt.allocPrint(a, "ffi-gen: cannot start \"{s}\" — install clang or set --clang= (spawnSync {s} {s})", .{ clang, clang, code }) catch oom() };
    };
    const status: ?u8 = switch (run.term) {
        .exited => |code| code,
        else => null,
    };
    if (status != @as(?u8, 0)) {
        var shown: [8]u8 = undefined;
        const exit = if (status) |code| std.fmt.bufPrint(&shown, "{d}", .{code}) catch unreachable else "null";
        return .{ .failed = std.fmt.allocPrint(a, "ffi-gen: clang failed on {s} (exit {s}):\n{s}", .{ header, exit, firstLines(a, run.stderr) }) catch oom() };
    }
    // Duplicate keys and bytes that are not UTF-8 are what `JSON.parse` over a decoded string
    // accepts; a dump this deep cannot overflow the stack, because the parser keeps its own.
    const parsed = std.json.parseFromSliceLeaky(Json, a, text.lossyUtf8(a, run.stdout), .{ .duplicate_field_behavior = .use_last }) catch |err| switch (err) {
        error.OutOfMemory => oom(),
        else => return .{ .failed = std.fmt.allocPrint(a, "ffi-gen: clang produced unparseable JSON for {s}", .{header}) catch oom() },
    };
    if (parsed != .object) return .{ .failed = std.fmt.allocPrint(a, "ffi-gen: clang produced a non-object AST for {s}", .{header}) catch oom() };
    return .{ .root = parsed };
}

const testing = std.testing;

fn parseJson(a: Allocator, source: []const u8) !Json {
    return std.json.parseFromSliceLeaky(Json, a, source, .{});
}

test "a field of the wrong shape reads as absent" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const node = try parseJson(a, "{\"kind\":3,\"loc\":{\"line\":-1,\"offset\":\"x\",\"file\":7},\"type\":[],\"inner\":{}}");
    try testing.expectEqual(@as(?[]const u8, null), strField(node, "kind"));
    try testing.expectEqual(@as(u32, 0), nodeLoc(node).line);
    try testing.expectEqual(@as(?[]const u8, null), nodeLoc(node).file);
    try testing.expectEqual(@as(?u32, null), nodeOffset(node));
    try testing.expectEqual(@as(?[]const u8, null), nodeQualType(node));
    try testing.expectEqual(@as(usize, 0), nodeChildren(node).len);
}

test "numbers a position cannot be" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_][]const u8{ "1e400", "1.5", "99999999999999999999", "-3", "1e300" }) |number| {
        const node = try parseJson(a, try std.fmt.allocPrint(a, "{{\"loc\":{{\"line\":{s}}}}}", .{number}));
        try testing.expectEqual(@as(u32, 0), nodeLoc(node).line);
    }
    try testing.expectEqual(@as(u32, 12), nodeLoc(try parseJson(a, "{\"loc\":{\"line\":12.0}}")).line);
}

test "stderr keeps its first five lines" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("1\n2\n3\n4\n5", firstLines(a, "\n1\n2\n3\n4\n5\n6\n7\n"));
    try testing.expectEqualStrings("1\n2", firstLines(a, "1\n2\n"));
    try testing.expectEqualStrings("", firstLines(a, ""));
}
