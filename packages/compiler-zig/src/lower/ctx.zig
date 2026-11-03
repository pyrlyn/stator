//! State and small helpers shared by the lowering. One `Lower` per `lowerProgram`: the TypeScript
//! original keeps these as module-level variables reset at each entry.
const std = @import("std");
const Allocator = std.mem.Allocator;
const stator_ts = @import("stator_ts");
pub const api = @import("../frontend/gate_api.zig");
pub const gate = @import("../frontend/gate.zig");
pub const gt = @import("../frontend/gate_types.zig");
pub const narrowing = @import("../frontend/narrowing.zig");
pub const N = @import("../hir/nodes.zig");
pub const H = @import("../hir/types.zig");
pub const captures = @import("captures.zig");
const scope_mod = @import("scope.zig");
const specialize = @import("specialize.zig");
pub const support = @import("../support/root.zig");
const report = support.diagnostics;

pub const ast = api.ast;
pub const T = api.T;
pub const F = api.F;
pub const Tok = api.Tok;
pub const Gate = api.Gate;
pub const Node = api.Node;
pub const Symbol = api.Symbol;
pub const Type = api.Type;
pub const File = api.File;
pub const Mode = api.Mode;
pub const Diagnostic = api.Diagnostic;
pub const Scope = scope_mod.Scope;
pub const Expression = N.Expression;
pub const Statement = N.Statement;
pub const Block = N.Block;
pub const Span = N.Span;
pub const HType = H.HType;
pub const HObject = H.HObject;
pub const HField = H.HField;
pub const H_NUMBER = H.H_NUMBER;
pub const H_STRING = H.H_STRING;
pub const H_BOOLEAN = H.H_BOOLEAN;
pub const H_UNDEFINED = H.H_UNDEFINED;
pub const H_REGEXP = H.H_REGEXP;
pub const hUnknown = H.hUnknown;
pub const oom = api.oom;

/// A refusal is already in `Lower.diagnostics` when this is returned.
pub const E = error{Refused};

pub const StmtList = std.ArrayList(Statement);
pub const ExprList = std.ArrayList(Expression);
pub const NameSet = std.StringHashMapUnmanaged(void);
pub const OrderedNames = std.StringArrayHashMapUnmanaged(void);

const Lines = struct {
    /// Byte offset of each line's start.
    starts: []const u32,
    /// UTF-16 length of the text before each byte; null when the file is pure ASCII.
    utf16: ?[]const u32,
};

pub fn PayloadOf(comptime Union: type, comptime tag: std.meta.Tag(Union)) type {
    return @typeInfo(@FieldType(Union, @tagName(tag))).pointer.child;
}

/// One constructor per HIR union, so `ex` and `st` are the same code over different unions.
fn Boxed(comptime U: type) type {
    return struct {
        fn make(l: *Lower, comptime tag: std.meta.Tag(U), payload: PayloadOf(U, tag)) U {
            return @unionInit(U, @tagName(tag), l.create(payload));
        }
    };
}

pub const SpanRemap = struct {
    file: []const u8,
    map: *const fn (ctx: *anyopaque, line: u32, column: u32) ?Remapped,
    ctx: *anyopaque,
};

const UNMAPPED_FILE = "<package bundle>";

pub const Remapped = struct { file: []const u8, line: u32, column: u32 };

pub const Lower = struct {
    a: Allocator,
    g: *Gate,
    prog: *api.project.Program,
    checked: stator_ts.Session,
    /// The `sourceFile` argument threaded through every function of the original.
    sf: *File,
    diagnostics: std.ArrayList(Diagnostic) = .empty,
    span_remap: ?SpanRemap = null,
    /// The file a generic came from while it is lowered for a call in another one.
    foreign: ?*File = null,
    function_nesting: u32 = 0,
    immutable_self_bindings: NameSet = .empty,
    optional_chain_cuts: std.AutoHashMapUnmanaged(*Node, *const HType) = .empty,
    has_runtime_dynamic_symbols: bool = false,
    has_dynamic_return_symbols: bool = false,
    module_awaits: bool = false,
    module_scopes: std.AutoHashMapUnmanaged(*File, *Scope) = .empty,
    namespace_objects: std.AutoHashMapUnmanaged(*File, []const u8) = .empty,
    dependency_ordinals: std.AutoHashMapUnmanaged(*File, u32) = .empty,
    program_modules: []const *File = &.{},
    bind_temp_id: u32 = 0,
    shadow_counter: u32 = 0,
    hir_name_of_declaration: std.AutoHashMapUnmanaged(*Node, []const u8) = .empty,
    capture_cache: std.AutoHashMapUnmanaged(*File, *captures.CaptureMap) = .empty,
    lines: std.AutoHashMapUnmanaged(*File, Lines) = .empty,
    current_file_class_specs: []const specialize.ClassSpecialization = &.{},
    classes_in: std.AutoHashMapUnmanaged(*File, []const *Node) = .empty,

    // ---- nodes

    pub const ex = Boxed(Expression).make;
    pub const st = Boxed(Statement).make;

    pub fn create(l: *Lower, value: anytype) *@TypeOf(value) {
        const p = l.a.create(@TypeOf(value)) catch oom();
        p.* = value;
        return p;
    }

    pub fn dupe(l: *Lower, comptime X: type, items: []const X) []const X {
        return l.a.dupe(X, items) catch oom();
    }

    pub fn push(l: *Lower, list: anytype, item: anytype) void {
        list.append(l.a, item) catch oom();
    }

    pub fn a_appendAll(l: *Lower, list: anytype, items: anytype) void {
        for (items) |item| l.push(list, item);
    }

    pub fn fmt(l: *Lower, comptime format: []const u8, args: anytype) []const u8 {
        return std.fmt.allocPrint(l.a, format, args) catch oom();
    }

    pub fn concat(l: *Lower, parts: []const []const u8) []const u8 {
        return std.mem.concat(l.a, u8, parts) catch oom();
    }

    pub fn block(l: *Lower, at: Span, statements: []const Statement) *const Block {
        return l.create(Block{ .type = H_UNDEFINED, .span = at, .statements = statements });
    }

    pub fn number(l: *Lower, at: Span, value: f64) Expression {
        return l.ex(.number_literal, .{ .type = H_NUMBER, .span = at, .value = value });
    }

    pub fn string(l: *Lower, at: Span, value: []const u8) Expression {
        return l.ex(.string_literal, .{ .type = H_STRING, .span = at, .value = value });
    }

    pub fn undef(l: *Lower, at: Span) Expression {
        return l.ex(.undefined_literal, .{ .type = H_UNDEFINED, .span = at });
    }

    pub fn ident(l: *Lower, t: *const HType, at: Span, name: []const u8) Expression {
        return l.ex(.identifier, .{ .type = t, .span = at, .name = name });
    }

    // ---- types

    pub const hArray = wrapped(H.hArray);
    pub const hPromise = wrapped(H.hPromise);
    pub const hIterator = wrapped(H.hIterator);

    /// `Array<T>`, `Promise<T>` and the like, built in the lowering's arena.
    fn wrapped(comptime make: fn (std.mem.Allocator, *const HType) std.mem.Allocator.Error!*const HType) fn (*Lower, *const HType) *const HType {
        return struct {
            fn of(l: *Lower, inner: *const HType) *const HType {
                return make(l.a, inner) catch oom();
            }
        }.of;
    }

    pub fn hFunction(l: *Lower, params: []const *const HType, ret: *const HType) *const HType {
        return H.hFunction(l.a, params, ret) catch oom();
    }

    pub fn hObject(l: *Lower, name: []const u8, fields: []const HField, methods: []const HField, bases: []const []const u8, namespace: ?bool) *const HType {
        return H.hObject(l.a, name, fields, methods, bases, namespace) catch oom();
    }

    pub fn hTypeName(l: *Lower, t: *const HType) []const u8 {
        return H.hTypeName(l.a, t) catch oom();
    }

    pub fn accessorName(l: *Lower, kind: H.AccessorKind, property: []const u8) []const u8 {
        return H.accessorName(l.a, kind, property) catch oom();
    }

    pub fn toH(l: *Lower, t: *Type) *const HType {
        return gt.tsTypeToHType(l.g, t);
    }

    pub fn hAt(l: *Lower, n: *Node) *const HType {
        return gt.tsTypeToHType(l.g, l.g.typeAt(n));
    }

    pub fn session(l: *Lower) stator_ts.Session {
        return l.checked;
    }

    /// `checker.getFullyQualifiedName`.
    pub fn fqn(l: *Lower, s: *Symbol) []const u8 {
        return l.session().fullyQualifiedName(.{ .symbol = s.resolve() });
    }

    // ---- positions

    fn linesOf(l: *Lower, f: *File) Lines {
        if (l.lines.get(f)) |known| return known;
        const src = f.src;
        var starts: std.ArrayList(u32) = .empty;
        l.push(&starts, @as(u32, 0));
        var ascii = true;
        var i: usize = 0;
        while (i < src.len) : (i += 1) {
            const c = src[i];
            if (c >= 0x80) ascii = false;
            if (c == '\r') {
                if (i + 1 < src.len and src[i + 1] == '\n') i += 1;
                l.push(&starts, @as(u32, @intCast(i + 1)));
            } else if (c == '\n') {
                l.push(&starts, @as(u32, @intCast(i + 1)));
            } else if (c == 0xE2 and i + 2 < src.len and src[i + 1] == 0x80 and (src[i + 2] == 0xA8 or src[i + 2] == 0xA9)) {
                i += 2;
                l.push(&starts, @as(u32, @intCast(i + 1)));
            }
        }
        var utf16: ?[]const u32 = null;
        if (!ascii) {
            const table = l.a.alloc(u32, src.len + 1) catch oom();
            var code_units: u32 = 0;
            var at: usize = 0;
            while (at < src.len) {
                const width = std.unicode.utf8ByteSequenceLength(src[at]) catch 1;
                const end = @min(at + width, src.len);
                for (at..end) |j| table[j] = code_units;
                code_units += if (width == 4) 2 else 1;
                at = end;
            }
            table[src.len] = code_units;
            utf16 = table;
        }
        const out: Lines = .{ .starts = starts.items, .utf16 = utf16 };
        l.lines.put(l.a, f, out) catch oom();
        return out;
    }

    fn units(table: Lines, byte: u32) u32 {
        const t = table.utf16 orelse return byte;
        return t[@min(byte, t.len - 1)];
    }

    /// 1-based line and column of a byte offset, the column in UTF-16 units.
    pub fn position(l: *Lower, f: *File, byte: u32) struct { line: u32, column: u32 } {
        const table = l.linesOf(f);
        var low: usize = 0;
        var high: usize = table.starts.len;
        while (high - low > 1) {
            const mid = (low + high) / 2;
            if (table.starts[mid] <= byte) low = mid else high = mid;
        }
        return .{ .line = @intCast(low + 1), .column = units(table, byte) - units(table, table.starts[low]) + 1 };
    }

    fn remapPosition(l: *Lower, byte: u32) Remapped {
        const at = l.position(l.sf, byte);
        const remap = l.span_remap orelse return .{ .file = l.sf.path, .line = at.line, .column = at.column };
        if (!std.mem.eql(u8, l.sf.path, remap.file)) return .{ .file = l.sf.path, .line = at.line, .column = at.column };
        return remap.map(remap.ctx, at.line, at.column) orelse .{ .file = UNMAPPED_FILE, .line = at.line, .column = at.column };
    }

    /// `makeSpan`, from byte offsets.
    pub fn makeSpan(l: *Lower, start: u32, end: u32) Span {
        const table = l.linesOf(l.sf);
        const at = l.remapPosition(start);
        const first = units(table, start);
        return .{ .start = first, .length = units(table, end) - first, .line = at.line, .file = at.file };
    }

    pub fn span(l: *Lower, n: *const Node) Span {
        if (n.data == .source_file) return l.makeSpan(skipTrivia(l.sf.src, 0), n.end);
        // The oracle asks for a generic's start against the file of the call that instantiated it,
        // which reads the node's full start in that file's text. The HIR records what it gets.
        if (l.foreign) |home| return l.makeSpan(skipTrivia(l.sf.src, fullStart(home.src, n.start)), n.end);
        return l.makeSpan(n.start, n.end);
    }

    /// Where the trivia before a token begins, reading backwards: only a line's own start can tell
    /// whether a `//` in it opens a comment.
    fn fullStart(src: []const u8, start: u32) u32 {
        var at: usize = @min(start, src.len);
        while (true) {
            while (at > 0 and std.ascii.isWhitespace(src[at - 1])) at -= 1;
            if (at >= 2 and src[at - 1] == '/' and src[at - 2] == '*') {
                at = std.mem.lastIndexOf(u8, src[0 .. at - 2], "/*") orelse return @intCast(at);
                continue;
            }
            const line = if (std.mem.lastIndexOfAny(u8, src[0..at], "\r\n")) |x| x + 1 else 0;
            at = lineComment(src[line..at]) orelse return @intCast(at);
            at += line;
        }
    }

    fn lineComment(line: []const u8) ?usize {
        var quote: u8 = 0;
        var i: usize = 0;
        while (i < line.len) : (i += 1) {
            const ch = line[i];
            if (quote != 0) {
                if (ch == '\\') i += 1 else if (ch == quote) quote = 0;
            } else if (ch == '"' or ch == '\'' or ch == '`') {
                quote = ch;
            } else if (ch == '/' and i + 1 < line.len and line[i + 1] == '/') {
                return i;
            }
        }
        return null;
    }

    fn skipTrivia(src: []const u8, from: u32) u32 {
        var at: usize = @min(from, src.len);
        while (at < src.len) {
            if (std.ascii.isWhitespace(src[at])) {
                at += 1;
            } else if (std.mem.startsWith(u8, src[at..], "//")) {
                at = std.mem.indexOfAnyPos(u8, src, at, "\r\n") orelse src.len;
            } else if (std.mem.startsWith(u8, src[at..], "/*")) {
                const close = std.mem.indexOfPos(u8, src, at + 2, "*/") orelse return @intCast(src.len);
                at = close + 2;
            } else {
                break;
            }
        }
        return @intCast(at);
    }

    pub fn checkLocation(l: *Lower, n: *const Node) []const u8 {
        const at = l.remapPosition(n.start);
        return l.fmt("{s}:{d}:{d}", .{ at.file, at.line, at.column });
    }

    // ---- diagnostics

    /// For the walks the original lets finish after a failure, to report everything they find.
    pub fn note(l: *Lower, n: *const Node, code: []const u8, class: report.Class, message: []const u8) void {
        const f = l.sf;
        l.diagnostics.append(l.a, report.fromRange(f.path, f.src, n.start, n.end, code, class, l.g.mode, message, null)) catch oom();
    }

    pub fn refuse(l: *Lower, n: *const Node, code: []const u8, class: report.Class, message: []const u8) E {
        l.note(n, code, class, message);
        return error.Refused;
    }

    pub fn notYet(l: *Lower, n: *const Node, message: []const u8) E {
        return l.refuse(n, "STA1214", .@"not-yet", message);
    }

    pub fn internal(l: *Lower, n: *const Node, code: []const u8, message: []const u8) E {
        return l.refuse(n, code, .internal, message);
    }

    // ---- binding names

    pub fn hirNameOf(l: *Lower, decl: ?*Node) ?[]const u8 {
        return l.hir_name_of_declaration.get(decl orelse return null);
    }

    pub fn setHirName(l: *Lower, decl: *Node, name: []const u8) void {
        l.hir_name_of_declaration.put(l.a, decl, name) catch oom();
    }

    pub fn nextBindTemp(l: *Lower) []const u8 {
        l.bind_temp_id += 1;
        return l.fmt(" bind{d}", .{l.bind_temp_id});
    }

    pub fn capturesFor(l: *Lower, f: *File) *captures.CaptureMap {
        if (l.capture_cache.get(f)) |known| return known;
        const computed = captures.analyzeCaptures(l.a, l.g, f.root);
        l.capture_cache.put(l.a, f, computed) catch oom();
        return computed;
    }

    pub fn fileOfNode(l: *Lower, n: *Node) *File {
        return l.g.fileOf(n) orelse l.sf;
    }

    pub fn functionSpecializationName(l: *Lower, declaration: *Node, key: []const u8, type_arguments: []const *const HType) []const u8 {
        const name = H.specializationName(l.a, key, type_arguments) catch oom();
        const ordinal = l.dependency_ordinals.get(l.fileOfNode(declaration)) orelse return name;
        return l.fmt("{s}@{d}", .{ name, ordinal });
    }
};

pub fn arithmeticBinOp(l: *Lower, operator: N.BinaryOperator, left: Expression, right: Expression, span: Span, fallback: *const HType) Expression {
    const coercing = switch (operator) {
        .@"-", .@"*", .@"/", .@"%", .@"**" => true,
        else => false,
    };
    return l.ex(.binary_op, .{ .type = if (coercing and fallback.* == .unknown) H_NUMBER else fallback, .span = span, .operator = operator, .left = left, .right = right });
}

pub const eql = api.eql;

/// `hasTypeScriptAnnotation`.
pub fn hasTypeScriptAnnotation(l: *Lower, declaration: *Node) bool {
    if (support.node_field.of(?*Node, declaration, .{ .{ .var_decl, "type" }, .{ .param, "type" }, .{ .func, "ret" } }) == null) return false;
    const file = l.fileOfNode(declaration);
    if (file.is_dts) return false;
    const path = file.path;
    for ([_][]const u8{ ".js", ".jsx", ".mjs", ".mjsx", ".cjs", ".cjsx" }) |suffix| if (std.mem.endsWith(u8, path, suffix)) return false;
    return true;
}

pub const isIdentifier = api.isIdentifier;
pub const isFunctionLike = api.hasOwnBody;
