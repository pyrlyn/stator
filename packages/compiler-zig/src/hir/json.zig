//! HIR-JSON, the canonical text `packages/tests/zigdiff/dump-hir.ts` dumps and
//! `packages/tests/zigdiff/HIR-JSON.md` specifies: the TypeScript compiler's HIR is this compiler's
//! test input, and this module's output is compared with it byte for byte.
//!
//! Both directions are one walk over the types in `nodes.zig`, so a field added there is read and
//! written without a line here. The input is untrusted: every shape the writer cannot produce from
//! a tree is an error naming its offset, and the limits below keep it from exhausting the stack
//! here or in whatever walks the tree next.

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("nodes.zig");
const types = @import("types.zig");

const Expression = nodes.Expression;
const HType = types.HType;
const Module = nodes.Module;
const Span = nodes.Span;
const Statement = nodes.Statement;

pub const FORMAT = 1;

/// Arrays and objects open at once. Each level takes several stack frames, in this walk and in
/// every later one over the tree; the golden and subset corpus peaks at 45.
pub const MAX_DEPTH = 512;

/// `array of array of ...`: a type is one integer deep in the text, so `MAX_DEPTH` cannot see it.
pub const MAX_TYPE_DEPTH = 256;

/// Every NaN is one value to JavaScript, so its payload is not data, and the dump writes this one.
const CANONICAL_NAN: u64 = 0x7ff8000000000000;

pub const Failure = struct {
    offset: usize = 0,
    reason: []const u8 = "",
};

pub const ReadError = error{ InvalidHirJson, OutOfMemory };
pub const WriteError = error{ CyclicHir, OutOfMemory };

/// Everything read lives in `arena`, as a module's nodes do; nothing keeps a reference to `text`.
/// On `error.InvalidHirJson`, `failure` says what and where.
pub fn read(arena: Allocator, text: []const u8, failure: *Failure) ReadError!*const Module {
    var reader: Reader = .{ .arena = arena, .text = text, .failure = failure };
    return reader.document();
}

/// The canonical text of `module`, owned by `gpa`.
pub fn write(gpa: Allocator, module: *const Module) WriteError![]u8 {
    var scratch: std.heap.ArenaAllocator = .init(gpa);
    defer scratch.deinit();
    var body: std.ArrayList(u8) = .empty;
    var writer: Writer = .{ .arena = scratch.allocator(), .out = &body };
    try writer.countNode(Module, module);
    try writer.node(Module, module, "module");

    var text: std.ArrayList(u8) = .empty;
    errdefer text.deinit(gpa);
    writer = .{
        .arena = scratch.allocator(),
        .out = &text,
        .files = writer.files,
        .type_entries = writer.type_entries,
    };
    try text.print(gpa, "{{\"format\":{d},\"files\":[", .{FORMAT});
    writer.arena = gpa;
    for (writer.files.items, 0..) |file, i| {
        if (i != 0) try text.append(gpa, ',');
        try writer.string(file);
    }
    try text.appendSlice(gpa, "],\"types\":[");
    for (writer.type_entries.items, 0..) |entry, i| {
        if (i != 0) try text.append(gpa, ',');
        try text.appendSlice(gpa, entry);
    }
    try text.appendSlice(gpa, "],\"module\":");
    try text.appendSlice(gpa, body.items);
    try text.append(gpa, '}');
    return text.toOwnedSlice(gpa);
}

// ---------------------------------------------------------------------------------------------
// The spelling both directions share

fn kebab(comptime name: []const u8) []const u8 {
    comptime {
        var out = name[0..name.len].*;
        for (&out) |*c| {
            if (c.* == '_') c.* = '-';
        }
        const final = out;
        return &final;
    }
}

fn camel(comptime name: []const u8) []const u8 {
    comptime {
        @setEvalBranchQuota(10_000);
        var out: []const u8 = "";
        var upper = false;
        for (name) |c| {
            if (c == '_') {
                upper = true;
            } else {
                out = out ++ [1]u8{if (upper) std.ascii.toUpper(c) else c};
                upper = false;
            }
        }
        return out;
    }
}

const JsonField = struct { name: []const u8, key: []const u8 };

fn keyBefore(_: void, a: JsonField, b: JsonField) bool {
    return std.mem.lessThan(u8, a.key, b.key);
}

/// In key order, because that is the order the dump walks and so the order every id is handed out.
fn jsonFields(comptime T: type) []const JsonField {
    comptime {
        @setEvalBranchQuota(100_000);
        const names = @typeInfo(T).@"struct".field_names;
        var out: [names.len]JsonField = undefined;
        for (names, &out) |name, *field| field.* = .{ .name = name, .key = camel(name) };
        std.sort.insertion(JsonField, &out, {}, keyBefore);
        const final = out;
        return &final;
    }
}

fn kindOf(comptime T: type) []const u8 {
    comptime {
        @setEvalBranchQuota(100_000);
        if (T == Module) return "module";
        for ([_]type{ Expression, Statement }) |U| {
            const info = @typeInfo(U).@"union";
            for (info.field_names, info.field_types) |name, P| {
                if (P == *const T) return kebab(name);
            }
        }
        @compileError("not a node: " ++ @typeName(T));
    }
}

// ---------------------------------------------------------------------------------------------
// Reading

const Reader = struct {
    arena: Allocator,
    text: []const u8,
    failure: *Failure,
    pos: usize = 0,
    depth: u32 = 0,
    files: []const []const u8 = &.{},
    type_table: std.ArrayList(*const HType) = .empty,
    type_depths: std.ArrayList(u32) = .empty,
    /// The deepest type named since the current table entry began.
    type_depth: u32 = 0,
    /// Null while the node is still open: a `$ref` into it would be a cycle, which the walks over
    /// this tree do not expect and the dump cannot produce.
    ids: std.ArrayList(?Slot) = .empty,

    const Slot = struct { kind: []const u8, ptr: *const anyopaque };
    const Head = union(enum) { ref: Slot, kind: []const u8 };

    fn fail(self: *Reader, reason: []const u8) ReadError {
        self.failure.* = .{ .offset = self.pos, .reason = reason };
        return error.InvalidHirJson;
    }

    fn peek(self: *const Reader) ?u8 {
        return if (self.pos < self.text.len) self.text[self.pos] else null;
    }

    fn expect(self: *Reader, c: u8) ReadError!void {
        if (self.peek() != c) return self.fail("unexpected character");
        self.pos += 1;
    }

    fn accept(self: *Reader, literal: []const u8) bool {
        if (!std.mem.startsWith(u8, self.text[self.pos..], literal)) return false;
        self.pos += literal.len;
        return true;
    }

    fn require(self: *Reader, literal: []const u8) ReadError!void {
        if (!self.accept(literal)) return self.fail("unexpected text");
    }

    fn enter(self: *Reader, c: u8) ReadError!void {
        if (self.depth == MAX_DEPTH) return self.fail("nested too deeply");
        try self.expect(c);
        self.depth += 1;
    }

    fn document(self: *Reader) ReadError!*const Module {
        if (!std.unicode.utf8ValidateSlice(self.text)) return self.fail("not UTF-8");
        try self.require(std.fmt.comptimePrint("{{\"format\":{d},\"files\":", .{FORMAT}));
        self.files = try self.value([]const []const u8);
        try self.require(",\"types\":");
        try self.typeTable();
        try self.require(",\"module\":");
        const module = try self.node(Module);
        try self.expect('}');
        if (self.pos != self.text.len) return self.fail("text after the document");
        return module;
    }

    fn typeTable(self: *Reader) ReadError!void {
        try self.enter('[');
        var following = false;
        while (self.peek() != ']') : (following = true) {
            if (following) try self.expect(',');
            self.type_depth = 0;
            const entry = try self.arena.create(HType);
            entry.* = try self.unionValue(HType);
            if (self.type_depth >= MAX_TYPE_DEPTH) return self.fail("type nested too deeply");
            try self.type_table.append(self.arena, entry);
            try self.type_depths.append(self.arena, self.type_depth + 1);
        }
        self.pos += 1;
        self.depth -= 1;
    }

    fn value(self: *Reader, comptime T: type) ReadError!T {
        if (T == *const HType) return self.typeRef();
        if (T == Span) return self.span();
        if (T == []const u8) return self.string();
        if (T == f64) return self.float();
        switch (@typeInfo(T)) {
            .bool => {
                if (self.accept("true")) return true;
                if (self.accept("false")) return false;
                return self.fail("expected a boolean");
            },
            .int => return self.int(T),
            .@"enum" => return std.meta.stringToEnum(T, try self.bare()) orelse
                self.fail("unknown enum value"),
            .optional => |optional| {
                if (self.accept("null")) return null;
                return try self.value(optional.child);
            },
            .pointer => |pointer| return if (pointer.size == .slice)
                self.slice(pointer.child)
            else
                self.node(pointer.child),
            .@"union" => return self.unionValue(T),
            .@"struct" => {
                try self.enter('{');
                return self.fields(T, false);
            },
            else => @compileError("no JSON form: " ++ @typeName(T)),
        }
    }

    /// An absent key is the only spelling of an absent field, so `null` is not read here; only a
    /// position in an array can hold one.
    fn present(self: *Reader, comptime T: type) ReadError!T {
        return switch (@typeInfo(T)) {
            .optional => |optional| try self.value(optional.child),
            else => self.value(T),
        };
    }

    fn slice(self: *Reader, comptime E: type) ReadError![]const E {
        try self.enter('[');
        var items: std.ArrayList(E) = .empty;
        var following = false;
        while (self.peek() != ']') : (following = true) {
            if (following) try self.expect(',');
            try items.append(self.arena, try self.value(E));
        }
        self.pos += 1;
        self.depth -= 1;
        return items.toOwnedSlice(self.arena);
    }

    /// The object is open and, with `more`, already holds a key.
    fn fields(self: *Reader, comptime T: type, more: bool) ReadError!T {
        const table = comptime jsonFields(T);
        var seen: std.StaticBitSet(table.len) = .empty;
        var out: T = undefined;
        var following = more;
        keys: while (self.peek() != '}') : (following = true) {
            if (following) try self.expect(',');
            const at = self.pos;
            const key = try self.bare();
            try self.expect(':');
            inline for (table, 0..) |field, i| {
                if (std.mem.eql(u8, key, field.key)) {
                    if (seen.isSet(i)) {
                        self.pos = at;
                        return self.fail("duplicate key");
                    }
                    seen.set(i);
                    @field(out, field.name) = try self.present(@FieldType(T, field.name));
                    continue :keys;
                }
            }
            self.pos = at;
            return self.fail("unknown key");
        }
        self.pos += 1;
        self.depth -= 1;
        inline for (table, 0..) |field, i| {
            if (!seen.isSet(i)) {
                if (@typeInfo(@FieldType(T, field.name)) != .optional) {
                    return self.fail("missing key " ++ field.key);
                }
                @field(out, field.name) = null;
            }
        }
        return out;
    }

    fn head(self: *Reader) ReadError!Head {
        try self.enter('{');
        const key = try self.bare();
        try self.expect(':');
        if (std.mem.eql(u8, key, "kind")) return .{ .kind = try self.bare() };
        if (!std.mem.eql(u8, key, "$ref")) return self.fail("object does not begin with kind");
        const id = try self.int(u32);
        try self.expect('}');
        self.depth -= 1;
        if (id >= self.ids.items.len) return self.fail("$ref to an id not yet defined");
        return .{ .ref = self.ids.items[id] orelse return self.fail("$ref into an open node") };
    }

    fn unionValue(self: *Reader, comptime U: type) ReadError!U {
        const info = @typeInfo(U).@"union";
        switch (try self.head()) {
            .ref => |slot| {
                inline for (info.field_names, info.field_types) |name, P| {
                    if (@typeInfo(P) == .pointer) {
                        if (std.mem.eql(u8, slot.kind, comptime kebab(name))) {
                            return @unionInit(U, name, @ptrCast(@alignCast(slot.ptr)));
                        }
                    }
                }
                return self.fail("$ref to a node of the wrong kind");
            },
            .kind => |kind| {
                inline for (info.field_names, info.field_types) |name, P| {
                    if (std.mem.eql(u8, kind, comptime kebab(name))) {
                        return @unionInit(U, name, try self.payload(P, kind));
                    }
                }
                return self.fail("unknown kind");
            },
        }
    }

    fn payload(self: *Reader, comptime P: type, kind: []const u8) ReadError!P {
        if (P == void) {
            try self.expect('}');
            self.depth -= 1;
            return;
        }
        if (@typeInfo(P) == .pointer) return self.nodeBody(@typeInfo(P).pointer.child, kind);
        return self.fields(P, true);
    }

    fn node(self: *Reader, comptime T: type) ReadError!*const T {
        const kind = comptime kindOf(T);
        switch (try self.head()) {
            .ref => |slot| {
                if (!std.mem.eql(u8, slot.kind, kind)) {
                    return self.fail("$ref to a node of the wrong kind");
                }
                return @ptrCast(@alignCast(slot.ptr));
            },
            .kind => |found| {
                if (!std.mem.eql(u8, found, kind)) return self.fail("wrong node kind here");
                return self.nodeBody(T, kind);
            },
        }
    }

    fn nodeBody(self: *Reader, comptime T: type, kind: []const u8) ReadError!*const T {
        var id: ?usize = null;
        if (self.accept(",\"$id\":")) {
            const number = try self.int(u32);
            if (number != self.ids.items.len) return self.fail("$id out of sequence");
            try self.ids.append(self.arena, null);
            id = number;
        }
        const out = try self.arena.create(T);
        out.* = try self.fields(T, true);
        if (id) |number| self.ids.items[number] = .{ .kind = kind, .ptr = out };
        return out;
    }

    fn typeRef(self: *Reader) ReadError!*const HType {
        const id = try self.int(u32);
        if (id >= self.type_table.items.len) return self.fail("type id is not an earlier entry");
        self.type_depth = @max(self.type_depth, self.type_depths.items[id]);
        return self.type_table.items[id];
    }

    fn span(self: *Reader) ReadError!Span {
        try self.enter('[');
        var out: Span = .{ .start = try self.int(u32), .length = 0, .line = 0 };
        try self.expect(',');
        out.length = try self.int(u32);
        try self.expect(',');
        out.line = try self.int(u32);
        if (self.accept(",")) {
            const id = try self.int(u32);
            if (id >= self.files.len) return self.fail("file id out of range");
            out.file = self.files[id];
        }
        try self.expect(']');
        self.depth -= 1;
        return out;
    }

    /// A key, a kind, an enum tag or bit pattern: text with no escapes, borrowed from the input.
    fn bare(self: *Reader) ReadError![]const u8 {
        try self.expect('"');
        const start = self.pos;
        const end = std.mem.indexOfScalarPos(u8, self.text, start, '"') orelse
            return self.fail("unterminated string");
        self.pos = end + 1;
        return self.text[start..end];
    }

    fn string(self: *Reader) ReadError![]const u8 {
        try self.expect('"');
        var out: std.ArrayList(u8) = .empty;
        while (true) {
            const start = self.pos;
            while (self.pos < self.text.len) : (self.pos += 1) {
                switch (self.text[self.pos]) {
                    '"', '\\', 0...0x1f => break,
                    else => {},
                }
            }
            try out.appendSlice(self.arena, self.text[start..self.pos]);
            const c = self.peek() orelse return self.fail("unterminated string");
            self.pos += 1;
            switch (c) {
                '"' => return out.toOwnedSlice(self.arena),
                '\\' => try self.escape(&out),
                else => return self.fail("raw control character in a string"),
            }
        }
    }

    fn escape(self: *Reader, out: *std.ArrayList(u8)) ReadError!void {
        const c = self.peek() orelse return self.fail("unterminated string");
        self.pos += 1;
        const byte: u8 = switch (c) {
            '"', '\\', '/' => c,
            'b' => 0x08,
            'f' => 0x0c,
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'u' => return self.unicodeEscape(out),
            else => return self.fail("unknown escape"),
        };
        try out.append(self.arena, byte);
    }

    /// A pair is one code point; a surrogate alone stays one, three bytes of WTF-8, because a
    /// JavaScript string may hold it and a literal must keep it.
    fn unicodeEscape(self: *Reader, out: *std.ArrayList(u8)) ReadError!void {
        var unit: u21 = try self.hex4();
        if (std.unicode.utf16IsHighSurrogate(@intCast(unit))) {
            const mark = self.pos;
            if (self.accept("\\u")) {
                const low = try self.hex4();
                if (std.unicode.utf16IsLowSurrogate(low)) {
                    unit = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
                } else {
                    self.pos = mark;
                }
            }
        }
        var bytes: [4]u8 = undefined;
        const length = std.unicode.wtf8Encode(unit, &bytes) catch unreachable;
        try out.appendSlice(self.arena, bytes[0..length]);
    }

    fn hex4(self: *Reader) ReadError!u16 {
        if (self.text.len - self.pos < 4) return self.fail("short unicode escape");
        var out: u16 = 0;
        for (self.text[self.pos..][0..4]) |c| {
            const digit = std.fmt.charToDigit(c, 16) catch return self.fail("bad unicode escape");
            out = out << 4 | digit;
        }
        self.pos += 4;
        return out;
    }

    /// Exactly what `JSON.stringify` prints for a safe integer: no sign on zero, no leading zero,
    /// no fraction, no exponent.
    fn int(self: *Reader, comptime T: type) ReadError!T {
        const start = self.pos;
        _ = self.accept("-");
        const digits = self.pos;
        while (self.peek()) |c| : (self.pos += 1) {
            if (!std.ascii.isDigit(c)) break;
        }
        const token = self.text[digits..self.pos];
        if (token.len == 0) return self.fail("expected an integer");
        if (token[0] == '0' and (token.len > 1 or digits != start)) {
            return self.fail("not a canonical integer");
        }
        return std.fmt.parseInt(T, self.text[start..self.pos], 10) catch
            self.fail("integer out of range");
    }

    fn float(self: *Reader) ReadError!f64 {
        const digits = try self.bare();
        if (digits.len != 16) return self.fail("a number is 16 hexadecimal digits");
        var bits: u64 = 0;
        for (digits) |c| {
            if (std.ascii.isUpper(c)) return self.fail("not a canonical number");
            const digit = std.fmt.charToDigit(c, 16) catch return self.fail("not a number");
            bits = bits << 4 | digit;
        }
        const out: f64 = @bitCast(bits);
        if (std.math.isNan(out) and bits != CANONICAL_NAN) {
            return self.fail("not the canonical NaN");
        }
        return out;
    }
};

// ---------------------------------------------------------------------------------------------
// Writing

const Writer = struct {
    arena: Allocator,
    out: *std.ArrayList(u8),
    visits: std.AutoHashMapUnmanaged(*const anyopaque, Visit) = .empty,
    ids: std.AutoHashMapUnmanaged(*const anyopaque, u32) = .empty,
    type_ids: std.AutoHashMapUnmanaged(*const HType, ?u32) = .empty,
    type_text: std.StringHashMapUnmanaged(u32) = .empty,
    type_entries: std.ArrayList([]const u8) = .empty,
    file_ids: std.StringHashMapUnmanaged(u32) = .empty,
    files: std.ArrayList([]const u8) = .empty,

    const Visit = struct { open: bool, shared: bool };

    fn count(self: *Writer, comptime T: type, item: T) WriteError!void {
        if (T == *const HType or T == Span or T == []const u8) return;
        switch (@typeInfo(T)) {
            .optional => if (item) |inner| try self.count(@typeInfo(T).optional.child, inner),
            .pointer => |pointer| if (pointer.size == .slice) {
                for (item) |element| try self.count(pointer.child, element);
            } else {
                try self.countNode(pointer.child, item);
            },
            .@"union" => switch (item) {
                inline else => |inner| try self.count(@TypeOf(inner), inner),
            },
            .@"struct" => inline for (comptime jsonFields(T)) |field| {
                try self.count(@FieldType(T, field.name), @field(item, field.name));
            },
            else => {},
        }
    }

    fn countNode(self: *Writer, comptime T: type, item: *const T) WriteError!void {
        const visit = try self.visits.getOrPut(self.arena, item);
        if (visit.found_existing) {
            if (visit.value_ptr.open) return error.CyclicHir;
            visit.value_ptr.shared = true;
            return;
        }
        visit.value_ptr.* = .{ .open = true, .shared = false };
        try self.count(T, item.*);
        self.visits.getPtr(item).?.open = false;
    }

    fn raw(self: *Writer, text: []const u8) WriteError!void {
        try self.out.appendSlice(self.arena, text);
    }

    fn integer(self: *Writer, number: anytype) WriteError!void {
        try self.out.print(self.arena, "{d}", .{number});
    }

    fn value(self: *Writer, comptime T: type, item: T) WriteError!void {
        if (T == *const HType) return self.integer(try self.typeId(item));
        if (T == Span) return self.span(item);
        if (T == []const u8) return self.string(item);
        if (T == f64) return self.float(item);
        switch (@typeInfo(T)) {
            .bool => try self.raw(if (item) "true" else "false"),
            .int => try self.integer(item),
            .@"enum" => try self.string(@tagName(item)),
            .optional => |optional| if (item) |inner| {
                try self.value(optional.child, inner);
            } else {
                try self.raw("null");
            },
            .pointer => |pointer| if (pointer.size == .slice) {
                try self.raw("[");
                for (item, 0..) |element, i| {
                    if (i != 0) try self.raw(",");
                    try self.value(pointer.child, element);
                }
                try self.raw("]");
            } else {
                try self.node(pointer.child, item, comptime kindOf(pointer.child));
            },
            .@"union" => switch (item) {
                inline else => |inner, tag| {
                    const kind = comptime kebab(@tagName(tag));
                    const P = @TypeOf(inner);
                    if (@typeInfo(P) == .pointer) {
                        try self.node(@typeInfo(P).pointer.child, inner, kind);
                    } else {
                        try self.raw("{\"kind\":\"" ++ kind ++ "\"");
                        if (P != void) try self.fields(P, inner, true);
                        try self.raw("}");
                    }
                },
            },
            .@"struct" => {
                try self.raw("{");
                try self.fields(T, item, false);
                try self.raw("}");
            },
            else => @compileError("no JSON form: " ++ @typeName(T)),
        }
    }

    fn fields(self: *Writer, comptime T: type, item: T, more: bool) WriteError!void {
        var following = more;
        inline for (comptime jsonFields(T)) |field| {
            const F = @FieldType(T, field.name);
            const present: ?(switch (@typeInfo(F)) {
                .optional => |optional| optional.child,
                else => F,
            }) = @field(item, field.name);
            if (present) |inner| {
                if (following) try self.raw(",");
                following = true;
                try self.raw("\"" ++ field.key ++ "\":");
                try self.value(@TypeOf(inner), inner);
            }
        }
    }

    fn node(self: *Writer, comptime T: type, item: *const T, kind: []const u8) WriteError!void {
        if (self.ids.get(item)) |id| {
            try self.raw("{\"$ref\":");
            try self.integer(id);
            return self.raw("}");
        }
        try self.raw("{\"kind\":\"");
        try self.raw(kind);
        try self.raw("\"");
        if (self.visits.get(item)) |visit| {
            if (visit.shared) {
                const id = self.ids.count();
                try self.ids.put(self.arena, item, id);
                try self.raw(",\"$id\":");
                try self.integer(id);
            }
        }
        try self.fields(T, item.*, true);
        try self.raw("}");
    }

    fn span(self: *Writer, item: Span) WriteError!void {
        try self.out.print(self.arena, "[{d},{d},{d}", .{ item.start, item.length, item.line });
        if (item.file) |file| {
            const known = try self.file_ids.getOrPut(self.arena, file);
            if (!known.found_existing) {
                known.value_ptr.* = @intCast(self.files.items.len);
                try self.files.append(self.arena, file);
            }
            try self.raw(",");
            try self.integer(known.value_ptr.*);
        }
        try self.raw("]");
    }

    /// Interned by text with child ids in it, children first, so two objects spelling one type are
    /// one entry and the id does not depend on which object held it.
    fn typeId(self: *Writer, item: *const HType) WriteError!u32 {
        const memo = try self.type_ids.getOrPut(self.arena, item);
        if (memo.found_existing) return memo.value_ptr.* orelse error.CyclicHir;
        memo.value_ptr.* = null;

        var entry: std.ArrayList(u8) = .empty;
        const outer = self.out;
        self.out = &entry;
        defer self.out = outer;
        try self.value(HType, item.*);

        const known = try self.type_text.getOrPut(self.arena, entry.items);
        if (!known.found_existing) {
            known.value_ptr.* = @intCast(self.type_entries.items.len);
            try self.type_entries.append(self.arena, entry.items);
        }
        const id = known.value_ptr.*;
        // `item` again: the walk above grew the table `memo` pointed into.
        try self.type_ids.put(self.arena, item, id);
        return id;
    }

    fn float(self: *Writer, item: f64) WriteError!void {
        const bits: u64 = if (std.math.isNan(item)) CANONICAL_NAN else @bitCast(item);
        try self.out.print(self.arena, "\"{x:0>16}\"", .{bits});
    }

    /// What `JSON.stringify` prints, lone surrogates included.
    fn string(self: *Writer, text: []const u8) WriteError!void {
        try self.raw("\"");
        var i: usize = 0;
        while (i < text.len) {
            const c = text[i];
            switch (c) {
                '"' => try self.raw("\\\""),
                '\\' => try self.raw("\\\\"),
                0x08 => try self.raw("\\b"),
                0x0c => try self.raw("\\f"),
                '\n' => try self.raw("\\n"),
                '\r' => try self.raw("\\r"),
                '\t' => try self.raw("\\t"),
                0...0x07, 0x0b, 0x0e...0x1f => try self.out.print(self.arena, "\\u{x:0>4}", .{c}),
                0xed => if (i + 2 < text.len and text[i + 1] >= 0xa0) {
                    const unit = @as(u16, 0xd000) | @as(u16, text[i + 1] & 0x3f) << 6 |
                        (text[i + 2] & 0x3f);
                    try self.out.print(self.arena, "\\u{x:0>4}", .{unit});
                    i += 2;
                } else {
                    try self.out.append(self.arena, c);
                },
                else => try self.out.append(self.arena, c),
            }
            i += 1;
        }
        try self.raw("\"");
    }
};

// ---------------------------------------------------------------------------------------------

const testing = std.testing;

const SAMPLE =
    \\{"format":1,"files":["a\"😀\ud83d.ts"],"types":[{"kind":"number"},{"kind":"unknown","fromImplicitAny":false},{"kind":"undefined"},{"kind":"fn","params":[0],"ret":2},{"kind":"object","bases":["B"],"fields":[{"name":"x","type":0}],"methods":[{"name":"m","type":3}],"name":"C","namespace":true}],"module":{"kind":"module","envVars":[],"fileName":"a.ts","isAsync":false,"span":[0,1,1,0],"statements":[{"kind":"expression-statement","expression":{"kind":"binary-op","left":{"kind":"number-literal","$id":0,"span":[1,2,1],"type":0,"value":"8000000000000000"},"operator":"+","right":{"$ref":0},"span":[0,3,1],"type":0},"span":[0,3,1],"type":0},{"kind":"expression-statement","expression":{"kind":"string-literal","span":[0,1,1],"type":1,"value":"\u0001\n\ud83dé"},"span":[0,1,1],"type":4}],"type":2}}
;

fn readForTest(arena: Allocator, text: []const u8) ReadError!*const Module {
    var failure: Failure = .{};
    return read(arena, text, &failure);
}

fn expectRejected(text: []const u8) !void {
    var state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer state.deinit();
    try testing.expectError(error.InvalidHirJson, readForTest(state.allocator(), text));
}

/// `old` must be in `SAMPLE`.
fn expectVariantRejected(old: []const u8, new: []const u8) !void {
    const text = try std.mem.replaceOwned(u8, testing.allocator, SAMPLE, old, new);
    defer testing.allocator.free(text);
    try testing.expect(!std.mem.eql(u8, text, SAMPLE));
    try expectRejected(text);
}

test "a document reads back as the same text" {
    var state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const module = try readForTest(arena, SAMPLE);
    const text = try write(testing.allocator, module);
    defer testing.allocator.free(text);
    try testing.expectEqualStrings(SAMPLE, text);
}

test "an escaped pair is one code point, and the writer prints it raw" {
    var state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const escaped = try std.mem.replaceOwned(u8, arena, SAMPLE, "😀", "\\ud83d\\ude00");
    const text = try write(arena, try readForTest(arena, escaped));
    try testing.expectEqualStrings(SAMPLE, text);
}

test "identity survives a reference" {
    var state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer state.deinit();
    const module = try readForTest(state.allocator(), SAMPLE);
    const statement = module.statements[0].expression_statement;
    const sum = statement.expression.binary_op;
    try testing.expectEqual(sum.left.number_literal, sum.right.number_literal);
    try testing.expect(std.math.isNegativeZero(sum.left.number_literal.value));
    try testing.expectEqualStrings("\xed\xa0\xbd", module.statements[1]
        .expression_statement.expression.string_literal.value[2..5]);
}

test "the shapes no fixture reaches read and write the same way" {
    var state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    var failure: Failure = .{};
    const text = "{\"kind\":\"class-value\",\"className\":\"C\",\"span\":[0,1,1],\"type\":0}";
    const number: *const HType = types.H_NUMBER;
    var reader: Reader = .{ .arena = arena, .text = text, .failure = &failure };
    try reader.type_table.append(arena, number);
    try reader.type_depths.append(arena, 1);
    const value = try reader.value(Expression);
    try testing.expectEqualStrings("C", value.class_value.class_name);

    // `kind` here is an ordinary sorted key, so no head is expected of it.
    const row = "{\"binding\":\"b\",\"kind\":\"set\",\"name\":\"n\"}";
    reader = .{ .arena = arena, .text = row, .failure = &failure };
    const prop = try reader.value(nodes.StaticProp);
    try testing.expectEqual(.set, prop.kind);
    var out: std.ArrayList(u8) = .empty;
    var writer: Writer = .{ .arena = arena, .out = &out };
    try writer.value(nodes.StaticProp, prop);
    try testing.expectEqualStrings(row, out.items);
}

test "bad documents are errors" {
    try expectRejected("");
    try expectRejected("{");
    try expectRejected("[]");
    try expectRejected("null");
    try expectRejected("\xff");
    try expectRejected(SAMPLE ++ " ");
    try expectRejected(SAMPLE[0 .. SAMPLE.len - 1]);
    try expectVariantRejected("{\"format\":1", "{\"format\":2");
    // A key the structs do not declare, and one twice over.
    try expectVariantRejected("\"isAsync\":false", "\"isAsync\":false,\"extra\":1");
    try expectVariantRejected("\"isAsync\":false", "\"isAsync\":false,\"isAsync\":false");
    try expectVariantRejected("\"isAsync\":false,", "");
    try expectVariantRejected("\"fromImplicitAny\":false", "\"fromImplicitAny\":null");
    try expectVariantRejected("\"namespace\":true", "\"namespace\":null");
    try expectVariantRejected("{\"kind\":\"module\"", "{\"kind\":\"block\"");
    try expectVariantRejected("expression-statement", "no-such-statement");
    try expectVariantRejected("\"operator\":\"+\"", "\"operator\":\"#\"");
    // Ids: unknown, out of sequence, of the wrong kind, forward, out of range.
    try expectVariantRejected("{\"$ref\":0}", "{\"$ref\":1}");
    try expectVariantRejected("\"$id\":0", "\"$id\":1");
    try expectVariantRejected("{\"kind\":\"binary-op\",\"left\":", "{\"kind\":\"binary-op\",\"$id\":0,\"left\":");
    try expectVariantRejected("\"ret\":2", "\"ret\":3");
    try expectVariantRejected("\"ret\":2", "\"ret\":5000000000");
    try expectVariantRejected("[1,2,1]", "[1,2,1,1]");
    try expectVariantRejected("[1,2,1]", "[1,2]");
    try expectVariantRejected("[1,2,1]", "[1,-2,1]");
    try expectVariantRejected("[1,2,1]", "[01,2,1]");
    try expectVariantRejected("[1,2,1]", "[1.5,2,1]");
    // Numbers are bit patterns, and only the canonical NaN is one value.
    try expectVariantRejected("8000000000000000", "800000000000000");
    try expectVariantRejected("8000000000000000", "800000000000000G");
    try expectVariantRejected("8000000000000000", "7ff8000000000001");
    try expectVariantRejected("\\u0001", "\u{1}");
    try expectVariantRejected("\\u0001", "\\u01");
    try expectVariantRejected("\\u0001", "\\x");
}

test "a reference into its own open node is an error, not a cycle" {
    try expectVariantRejected(
        "\"left\":{\"kind\":\"number-literal\",\"$id\":0,\"span\":[1,2,1],\"type\":0,\"value\":\"8000000000000000\"}",
        "\"$id\":0,\"left\":{\"$ref\":0}",
    );
}

test "nesting past the limits is an error" {
    const gpa = testing.allocator;
    const nested = "{\"kind\":\"typeof\",\"operand\":";
    var text: std.ArrayList(u8) = .empty;
    defer text.deinit(gpa);
    try text.appendSlice(gpa, "{\"format\":1,\"files\":[],\"types\":[{\"kind\":\"number\"}]," ++
        "\"module\":{\"kind\":\"module\",\"statements\":[{\"kind\":\"expression-statement\",\"expression\":");
    for (0..MAX_DEPTH * 4) |_| try text.appendSlice(gpa, nested);
    {
        var state: std.heap.ArenaAllocator = .init(gpa);
        defer state.deinit();
        var failure: Failure = .{};
        try testing.expectError(error.InvalidHirJson, read(state.allocator(), text.items, &failure));
        try testing.expectEqualStrings("nested too deeply", failure.reason);
    }

    // The deepest tree the reader lets through has to survive the writer's walk as well.
    text.clearRetainingCapacity();
    const levels = MAX_DEPTH - 8;
    try text.appendSlice(gpa, "{\"format\":1,\"files\":[],\"types\":[{\"kind\":\"number\"}]," ++
        "\"module\":{\"kind\":\"module\",\"envVars\":[],\"fileName\":\"a\",\"isAsync\":false," ++
        "\"span\":[0,0,0],\"statements\":[{\"kind\":\"expression-statement\",\"expression\":");
    for (0..levels) |_| try text.appendSlice(gpa, nested);
    try text.appendSlice(gpa, "{\"kind\":\"null-literal\",\"span\":[0,0,0],\"type\":0}");
    for (0..levels) |_| try text.appendSlice(gpa, ",\"span\":[0,0,0],\"type\":0}");
    try text.appendSlice(gpa, ",\"span\":[0,0,0],\"type\":0}],\"type\":0}}");
    {
        var state: std.heap.ArenaAllocator = .init(gpa);
        defer state.deinit();
        const again = try write(gpa, try readForTest(state.allocator(), text.items));
        defer gpa.free(again);
        try testing.expectEqualStrings(text.items, again);
    }

    text.clearRetainingCapacity();
    try text.appendSlice(gpa, "{\"format\":1,\"files\":[],\"types\":[{\"kind\":\"number\"}");
    for (0..MAX_TYPE_DEPTH + 1) |i| try text.print(gpa, ",{{\"kind\":\"array\",\"element\":{d}}}", .{i});
    try text.appendSlice(gpa, "],\"module\":");
    var state: std.heap.ArenaAllocator = .init(gpa);
    defer state.deinit();
    var failure: Failure = .{};
    try testing.expectError(error.InvalidHirJson, read(state.allocator(), text.items, &failure));
    try testing.expectEqualStrings("type nested too deeply", failure.reason);
}

test "no single-byte change crashes the reader or the writer" {
    const gpa = testing.allocator;
    const text = try gpa.dupe(u8, SAMPLE);
    defer gpa.free(text);
    for (text, 0..) |original, i| {
        for ([_]u8{ 0, '"', '\\', '{', '}', '[', ']', ',', ':', '0', '9', 'a', '-', 0x80, 0xff }) |byte| {
            text[i] = byte;
            var state: std.heap.ArenaAllocator = .init(gpa);
            defer state.deinit();
            if (readForTest(state.allocator(), text)) |module| {
                gpa.free(try write(gpa, module));
            } else |err| {
                try testing.expectEqual(error.InvalidHirJson, err);
            }
        }
        text[i] = original;
    }
}
