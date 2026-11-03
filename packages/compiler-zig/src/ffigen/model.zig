//! The generator's small IR (`ffi-gen/model.ts`): header declarations from the clang JSON AST,
//! before the reverse ABI mapping sees them. Functions and globals come from the target header
//! only, because a binding wraps one header; typedefs, records and enums come from every file,
//! because a target signature may spell them.
const std = @import("std");
const Allocator = std.mem.Allocator;
const fspath = std.fs.path;
const ast = @import("ast.zig");
const text = @import("text.zig");
const Json = ast.Json;
const eql = std.mem.eql;
const oom = text.oom;

pub const CParam = struct { name: ?[]const u8, c_type: []const u8 };

pub const CFunction = struct {
    c_name: []const u8,
    line: u32,
    params: []const CParam,
    return_type: []const u8,
    variadic: bool = false,
    is_inline: bool = false,
    is_static: bool = false,
    has_body: bool = false,
};

pub const CTypedef = struct {
    name: []const u8,
    /// The sugared spelling: sugar is what carries struct-ness and the `size_t` name.
    underlying: []const u8,
    /// The anonymous struct, union or enum this typedef owns.
    anon_tag_id: ?[]const u8 = null,
};

pub const RecordTag = enum { @"struct", @"union" };

pub const CRecord = struct {
    id: []const u8,
    name: ?[]const u8,
    tag: RecordTag,
    complete: bool,
    has_bitfield: bool,
};

pub const CEnumConstant = struct { name: []const u8, line: u32 };

pub const CEnum = struct {
    id: []const u8,
    name: ?[]const u8,
    line: u32,
    constants: []const CEnumConstant,
};

pub const CMacro = struct { name: []const u8, line: u32, function_like: bool };

pub const CGlobal = struct { name: []const u8, line: u32, c_type: []const u8 };

pub const Typedefs = std.StringHashMapUnmanaged(CTypedef);
pub const Records = std.StringHashMapUnmanaged(CRecord);

pub const HeaderModel = struct {
    basename: []const u8,
    functions: []const CFunction = &.{},
    typedefs: Typedefs = .empty,
    records_by_id: Records = .empty,
    enums: []const CEnum = &.{},
    macros: []const CMacro = &.{},
    globals: []const CGlobal = &.{},
};

/// The target header's own nodes. `file` is absent when clang did not print one.
fn isTargetFile(a: Allocator, loc_file: ?[]const u8, target: []const u8, cwd: []const u8) bool {
    const file = loc_file orelse return true;
    const base = if (fspath.isAbsolute(target)) target else fspath.resolve(a, &.{ cwd, target }) catch oom();
    const node = if (fspath.isAbsolute(file)) file else fspath.resolve(a, &.{ cwd, file }) catch oom();
    return eql(u8, node, base);
}

fn recordOf(node: Json) ?CRecord {
    const id = ast.strField(node, "id") orelse return null;
    const used = ast.strField(node, "tagUsed") orelse return null;
    const tag: RecordTag = if (eql(u8, used, "struct")) .@"struct" else if (eql(u8, used, "union")) .@"union" else return null;
    var has_bitfield = false;
    for (ast.nodeChildren(node)) |child| {
        const kind = ast.strField(child, "kind") orelse continue;
        if (eql(u8, kind, "FieldDecl") and ast.boolField(child, "isBitfield") == true) has_bitfield = true;
    }
    return .{
        .id = id,
        .name = ast.strField(node, "name"),
        .tag = tag,
        .complete = ast.boolField(node, "completeDefinition") == true,
        .has_bitfield = has_bitfield,
    };
}

const Collector = struct {
    a: Allocator,
    lines: LineTable,
    records: Records = .empty,
    enums: std.ArrayList(CEnum) = .empty,
    enum_ids: std.StringHashMapUnmanaged(void) = .empty,
    /// C nests tag declarations, and a dump can nest further than a thread's stack does: an
    /// initializer's expression tree is walked too.
    pending: std.ArrayList(Json) = .empty,

    fn enumOf(c: *Collector, node: Json) ?CEnum {
        const id = ast.strField(node, "id") orelse return null;
        var constants: std.ArrayList(CEnumConstant) = .empty;
        for (ast.nodeChildren(node)) |child| {
            const kind = ast.strField(child, "kind") orelse continue;
            if (!eql(u8, kind, "EnumConstantDecl")) continue;
            const name = ast.strField(child, "name") orelse continue;
            constants.append(c.a, .{ .name = name, .line = c.lines.lineOf(child) }) catch oom();
        }
        return .{ .id = id, .name = ast.strField(node, "name"), .line = c.lines.lineOf(node), .constants = constants.items };
    }

    fn visit(c: *Collector, node: Json) void {
        const kind = ast.strField(node, "kind") orelse return;
        if (eql(u8, kind, "RecordDecl")) {
            const record = recordOf(node) orelse return;
            const slot = c.records.getOrPut(c.a, record.id) catch oom();
            if (!slot.found_existing) slot.value_ptr.* = record;
        } else if (eql(u8, kind, "EnumDecl")) {
            const found = c.enumOf(node) orelse return;
            const slot = c.enum_ids.getOrPut(c.a, found.id) catch oom();
            if (!slot.found_existing) c.enums.append(c.a, found) catch oom();
        }
    }

    fn collectTags(c: *Collector, root: Json) void {
        c.pending.append(c.a, root) catch oom();
        while (c.pending.pop()) |node| {
            c.visit(node);
            const children = ast.nodeChildren(node);
            var at = children.len;
            while (at > 0) {
                at -= 1;
                if (children[at] == .object) c.pending.append(c.a, children[at]) catch oom();
            }
        }
    }
};

/// Clang omits `line` when it repeats the previous one, so a node's line is recovered from its
/// byte offset. The starts count UTF-16 units against byte offsets, as `buildModel` does: a line
/// after a non-ASCII byte reads early, and the generated file has to read the same.
const LineTable = struct {
    starts: []const u32,

    fn of(a: Allocator, header: []const u8) LineTable {
        var starts: std.ArrayList(u32) = .empty;
        starts.append(a, 0) catch oom();
        var units: u32 = 0;
        var i: usize = 0;
        while (i < header.len) {
            const b = header[i];
            const len: usize = std.unicode.utf8ByteSequenceLength(b) catch 1;
            units += if (len == 4) 2 else 1;
            i += len;
            if (b == '\n') starts.append(a, units) catch oom();
        }
        return .{ .starts = starts.items };
    }

    fn lineOf(t: LineTable, node: Json) u32 {
        const loc = ast.nodeLoc(node);
        if (loc.line > 0) return loc.line;
        const offset = ast.nodeOffset(node) orelse return 0;
        const after = std.sort.upperBound(u32, t.starts, offset, orderOffset);
        return @intCast(after);
    }

    fn orderOffset(offset: u32, start: u32) std.math.Order {
        return std.math.order(offset, start);
    }
};

/// `/^\s*#\s*/` followed by `word`: the index after it.
fn directive(raw: []const u8, word: []const u8) ?usize {
    var at = text.skipSpaces(raw, 0);
    if (at >= raw.len or raw[at] != '#') return null;
    at = text.skipSpaces(raw, at + 1);
    return if (std.mem.startsWith(u8, raw[at..], word)) at + word.len else null;
}

/// Where `.*` stops: `.` crosses no line terminator, and a line split on `\n` can still hold the
/// others.
fn dotRun(s: []const u8, from: usize) usize {
    var i = from;
    while (i < s.len) {
        if (s[i] == '\r') return i;
        if (std.mem.startsWith(u8, s[i..], "\u{2028}") or std.mem.startsWith(u8, s[i..], "\u{2029}")) return i;
        i += 1;
    }
    return i;
}

/// `defined\s*\(\s*(ident)\s*\)` at `at`.
fn definedAt(raw: []const u8, at: usize) ?[]const u8 {
    if (!std.mem.startsWith(u8, raw[at..], "defined")) return null;
    var i = text.skipSpaces(raw, at + "defined".len);
    if (i >= raw.len or raw[i] != '(') return null;
    i = text.skipSpaces(raw, i + 1);
    const end = text.identifierEnd(raw, i) orelse return null;
    const close = text.skipSpaces(raw, end);
    if (close >= raw.len or raw[close] != ')') return null;
    return raw[i..end];
}

const Guard = union(enum) {
    none,
    /// The conditional opens no guard candidate: `#ifdef X` matches but captures nothing.
    cleared,
    name: []const u8,
};

/// `/^\s*#\s*if(?:ndef\s+(ident)|def\b.*|.*defined\s*\(\s*(ident)\s*\))/`.
fn guardOf(raw: []const u8) Guard {
    const after_if = directive(raw, "if") orelse return .none;
    if (std.mem.startsWith(u8, raw[after_if..], "ndef")) {
        const at = after_if + "ndef".len;
        const name_at = text.skipSpaces(raw, at);
        if (name_at > at) {
            if (text.identifierEnd(raw, name_at)) |end| return .{ .name = raw[name_at..end] };
        }
    }
    if (std.mem.startsWith(u8, raw[after_if..], "def")) {
        const end = after_if + "def".len;
        if (end == raw.len or !text.isWordByte(raw[end])) return .cleared;
    }
    // Greedy `.*`: the last `defined(...)` before a line terminator wins.
    var at = dotRun(raw, after_if) + 1;
    while (at > after_if) {
        at -= 1;
        if (at < raw.len) {
            if (definedAt(raw, at)) |name| return .{ .name = name };
        }
    }
    return .none;
}

const Define = struct { name: []const u8, function_like: bool };

/// `/^\s*#\s*define\s+(ident)(?=\s|\(|$)(.*)$/`. The final `$` is the end of the line's text, so a
/// CRLF header's `\r` fails the match: `.` does not cross it.
fn defineOf(raw: []const u8) ?Define {
    const at = directive(raw, "define") orelse return null;
    const name_at = text.skipSpaces(raw, at);
    if (name_at == at) return null;
    const end = text.identifierEnd(raw, name_at) orelse return null;
    if (end < raw.len and raw[end] != '(' and text.spaceAt(raw, end) == 0) return null;
    if (dotRun(raw, end) != raw.len) return null;
    return .{ .name = raw[name_at..end], .function_like = end < raw.len and raw[end] == '(' };
}

/// Macros never reach the AST as declarations, so the text scan is the only enumeration. The
/// include guard is not a constant anyone binds.
fn scanMacros(a: Allocator, header: []const u8) []const CMacro {
    var macros: std.ArrayList(CMacro) = .empty;
    var guard: ?[]const u8 = null;
    var line: u32 = 0;
    var lines = std.mem.splitScalar(u8, header, '\n');
    while (lines.next()) |raw| {
        line += 1;
        switch (guardOf(raw)) {
            .name => |name| {
                guard = name;
                continue;
            },
            .cleared => {
                guard = null;
                continue;
            },
            .none => {},
        }
        const define = defineOf(raw) orelse {
            const body = text.trimStart(raw);
            if (body.len != 0 and !std.mem.startsWith(u8, body, "//") and !std.mem.startsWith(u8, body, "/*")) guard = null;
            continue;
        };
        const was_guard = guard != null and eql(u8, guard.?, define.name);
        guard = null;
        if (!was_guard) macros.append(a, .{ .name = define.name, .line = line, .function_like = define.function_like }) catch oom();
    }
    return macros.items;
}

/// `qualType.replace(/\s*\([^()]*\)\s*$/, '').trim()`: the function type minus its trailing
/// parameter list.
pub fn returnSpelling(qual_type: []const u8) []const u8 {
    const end = text.skipSpacesBack(qual_type, qual_type.len);
    if (end == 0 or qual_type[end - 1] != ')') return text.trim(qual_type);
    var open = end - 1;
    while (open > 0) {
        open -= 1;
        switch (qual_type[open]) {
            '(' => return text.trim(qual_type[0..text.skipSpacesBack(qual_type, open)]),
            ')' => return text.trim(qual_type),
            else => {},
        }
    }
    return text.trim(qual_type);
}

fn basenameOf(path: []const u8) []const u8 {
    const slash = std.mem.lastIndexOfAny(u8, path, "/\\") orelse return path;
    return path[slash + 1 ..];
}

fn functionOf(a: Allocator, node: Json, line: u32) ?CFunction {
    const c_name = ast.strField(node, "name") orelse return null;
    const qual_type = ast.nodeQualType(node) orelse return null;
    var params: std.ArrayList(CParam) = .empty;
    var has_body = false;
    for (ast.nodeChildren(node)) |child| {
        const kind = ast.strField(child, "kind") orelse continue;
        if (eql(u8, kind, "ParmVarDecl")) {
            const c_type = ast.nodeQualType(child) orelse continue;
            params.append(a, .{ .name = ast.strField(child, "name"), .c_type = c_type }) catch oom();
        } else if (eql(u8, kind, "CompoundStmt")) {
            has_body = true;
        }
    }
    const storage = ast.strField(node, "storageClass");
    return .{
        .c_name = c_name,
        .line = line,
        .params = params.items,
        .return_type = returnSpelling(qual_type),
        .variadic = ast.boolField(node, "variadic") == true,
        .is_inline = ast.boolField(node, "inline") == true,
        .is_static = storage != null and eql(u8, storage.?, "static"),
        .has_body = has_body,
    };
}

pub fn buildModel(a: Allocator, root: Json, header_path: []const u8, header_text: []const u8, cwd: []const u8) HeaderModel {
    var functions: std.ArrayList(CFunction) = .empty;
    var globals: std.ArrayList(CGlobal) = .empty;
    var typedefs: Typedefs = .empty;
    var tags: Collector = .{ .a = a, .lines = LineTable.of(a, header_text) };

    for (ast.nodeChildren(root)) |node| {
        if (node != .object or ast.boolField(node, "isImplicit") == true) continue;
        const kind = ast.strField(node, "kind") orelse continue;
        const loc = ast.nodeLoc(node);
        const line = tags.lines.lineOf(node);
        if (eql(u8, kind, "TypedefDecl")) {
            if (ast.strField(node, "name")) |name| {
                if (ast.nodeQualType(node)) |underlying| {
                    const slot = typedefs.getOrPut(a, name) catch oom();
                    if (!slot.found_existing) slot.value_ptr.* = .{ .name = name, .underlying = underlying, .anon_tag_id = ast.typedefOwnedTagId(node) };
                }
            }
            tags.collectTags(node);
        } else if (eql(u8, kind, "RecordDecl") or eql(u8, kind, "EnumDecl")) {
            tags.collectTags(node);
        } else if (eql(u8, kind, "FunctionDecl")) {
            if (!isTargetFile(a, loc.file, header_path, cwd)) continue;
            if (functionOf(a, node, line)) |function| functions.append(a, function) catch oom();
        } else if (eql(u8, kind, "VarDecl")) {
            if (!isTargetFile(a, loc.file, header_path, cwd)) continue;
            const name = ast.strField(node, "name") orelse continue;
            const c_type = ast.nodeQualType(node) orelse continue;
            globals.append(a, .{ .name = name, .line = line, .c_type = c_type }) catch oom();
        }
    }

    return .{
        .basename = basenameOf(header_path),
        .functions = functions.items,
        .typedefs = typedefs,
        .records_by_id = tags.records,
        .enums = tags.enums.items,
        .macros = scanMacros(a, header_text),
        .globals = globals.items,
    };
}

const testing = std.testing;

fn macrosOf(a: Allocator, header: []const u8) []const CMacro {
    return scanMacros(a, header);
}

test "the include guard is skipped and every other define is a macro" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const macros = macrosOf(arena.allocator(), "#ifndef A_H\n#define A_H\n#define B 1\n#define C(x) x\n#endif\n");
    try testing.expectEqual(@as(usize, 2), macros.len);
    try testing.expectEqualStrings("B", macros[0].name);
    try testing.expectEqual(@as(u32, 3), macros[0].line);
    try testing.expect(macros[1].function_like);
}

test "a guard survives blank and comment lines, and nothing else" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqual(@as(usize, 0), macrosOf(a, "#ifndef G\n\n// c\n/* d */\n#define G\n").len);
    try testing.expectEqual(@as(usize, 1), macrosOf(a, "#ifndef G\nint x;\n#define G\n").len);
    try testing.expectEqual(@as(usize, 0), macrosOf(a, "#if !defined(G)\n#define G\n").len);
    try testing.expectEqual(@as(usize, 1), macrosOf(a, "#ifdef G\n#define G\n").len);
    try testing.expectEqual(@as(usize, 0), macrosOf(a, "#if defined(A) && defined(G)\n#define G\n").len);
}

test "a CR hides the define, because `.` does not cross it" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqual(@as(usize, 0), macrosOf(arena.allocator(), "#define A 1\r\n").len);
}

test "define stops at what cannot follow a name" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqual(@as(usize, 0), macrosOf(a, "#define A-B\n").len);
    try testing.expectEqual(@as(usize, 1), macrosOf(a, "#  define\tA\n").len);
    try testing.expectEqual(@as(usize, 1), macrosOf(a, "  #define A\u{a0}1\n").len);
    try testing.expectEqual(@as(usize, 0), macrosOf(a, "#define\n").len);
    try testing.expectEqual(@as(usize, 0), macrosOf(a, "#defineA 1\n").len);
}

test "the return spelling loses only a trailing parameter list" {
    try testing.expectEqualStrings("const char *", returnSpelling("const char *(sqlite3 *)"));
    try testing.expectEqualStrings("int", returnSpelling("int (void)"));
    try testing.expectEqualStrings("void (*)(int)", returnSpelling("void (*)(int) (void) "));
    try testing.expectEqualStrings("void (void) __attribute__((noreturn))", returnSpelling("void (void) __attribute__((noreturn))"));
    try testing.expectEqualStrings("int", returnSpelling("int"));
    try testing.expectEqualStrings("", returnSpelling("(void)"));
    try testing.expectEqualStrings(")", returnSpelling(")"));
}

test "a line comes from the offset when clang leaves it out" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const lines = LineTable.of(a, "ab\ncd\n");
    const at = struct {
        fn run(x: Allocator, t: LineTable, offset: u32) !u32 {
            const node = try std.json.parseFromSliceLeaky(Json, x, try std.fmt.allocPrint(x, "{{\"loc\":{{\"offset\":{d}}}}}", .{offset}), .{});
            return t.lineOf(node);
        }
    }.run;
    try testing.expectEqual(@as(u32, 1), try at(a, lines, 0));
    try testing.expectEqual(@as(u32, 1), try at(a, lines, 2));
    try testing.expectEqual(@as(u32, 2), try at(a, lines, 3));
    try testing.expectEqual(@as(u32, 3), try at(a, lines, 6));
    try testing.expectEqual(@as(u32, 3), try at(a, lines, 600));
}

test "a tree deeper than any stack is walked" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var source: std.ArrayList(u8) = .empty;
    const depth = 200_000;
    for (0..depth) |_| try source.appendSlice(a, "{\"kind\":\"X\",\"inner\":[");
    try source.appendSlice(a, "{\"kind\":\"RecordDecl\",\"id\":\"r\",\"tagUsed\":\"struct\"}");
    for (0..depth) |_| try source.appendSlice(a, "]}");
    const node = try std.json.parseFromSliceLeaky(Json, a, source.items, .{});
    var tags: Collector = .{ .a = a, .lines = LineTable.of(a, "") };
    tags.collectTags(node);
    try testing.expect(tags.records.get("r") != null);
}
