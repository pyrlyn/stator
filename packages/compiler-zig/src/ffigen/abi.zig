//! The ABI table in reverse (docs/FFI.md §2, `ffi-gen/abi.ts`): C spellings to Stator declaration
//! spellings. C `int` and its kin and `size_t` widen to `number`; 64-bit integers are refused,
//! because `number` cannot hold every int64 exactly; no error convention is ever inferred.
const std = @import("std");
const Allocator = std.mem.Allocator;
const model_ = @import("model.zig");
const text = @import("text.zig");
const CFunction = model_.CFunction;
const HeaderModel = model_.HeaderModel;
const eql = std.mem.eql;
const startsWith = std.mem.startsWith;
const endsWith = std.mem.endsWith;
const contains = std.mem.containsAtLeast;
const oom = text.oom;
const fmt = text.fmt;
const collapseSpaces = text.collapseSpaces;

pub const TsPrimitive = enum { number, boolean, void, cstring };
pub const CNote = enum { int, size };
pub const Position = enum { param, @"return" };

pub const BrandRef = struct { alias: []const u8, tag: []const u8 };

pub const AbiOk = union(enum) {
    primitive: struct { ts: TsPrimitive, c_note: ?CNote = null },
    pointer: BrandRef,
    out_param: BrandRef,
};

pub const AbiRefusal = struct {
    /// Short and stable: the summary line counts per kind.
    kind: []const u8,
    reason: []const u8,
    /// The gate code the hand-written equivalent would earn (docs/DIAGNOSTICS.md).
    code: ?[]const u8,
};

pub const AbiResult = union(enum) { ok: AbiOk, refused: AbiRefusal };

fn refuse(kind: []const u8, reason: []const u8, code: []const u8) AbiResult {
    return .{ .refused = .{ .kind = kind, .reason = reason, .code = code } };
}

fn primitive(ts: TsPrimitive, note: ?CNote) AbiResult {
    return .{ .ok = .{ .primitive = .{ .ts = ts, .c_note = note } } };
}

fn pointer(a: Allocator, tag: []const u8) AbiResult {
    return .{ .ok = .{ .pointer = .{ .alias = brandAlias(a, tag), .tag = tag } } };
}

const Set = std.StaticStringMap(void);

fn setOf(comptime words: []const []const u8) Set {
    comptime var rows: [words.len]struct { []const u8 } = undefined;
    for (words, 0..) |word, i| rows[i] = .{word};
    return Set.initComptime(rows);
}

const int32 = setOf(&.{ "char", "signed char", "unsigned char", "short", "short int", "signed short", "unsigned short", "int", "signed", "signed int", "unsigned", "unsigned int" });

const int64 = setOf(&.{
    "long",             "long int",             "signed long",        "signed long int",
    "unsigned long",    "unsigned long int",    "long long",          "long long int",
    "signed long long", "signed long long int", "unsigned long long", "unsigned long long int",
    "__int64",          "int64_t",              "uint64_t",           "int_least64_t",
    "uint_least64_t",   "int_fast64_t",         "uint_fast64_t",
});

const floats = setOf(&.{ "float", "double", "long double" });
const bools = setOf(&.{ "bool", "_Bool" });

/// Follows a typedef chain to its underlying spelling; `size_t` is answered by name elsewhere,
/// because its width is the platform's and its spelling is not.
fn resolveTypedef(a: Allocator, name: []const u8, model: *const HeaderModel) ?[]const u8 {
    var seen: std.StringHashMapUnmanaged(void) = .empty;
    var current = name;
    while (true) {
        const slot = seen.getOrPut(a, current) catch oom();
        if (slot.found_existing) return null;
        const found = model.typedefs.get(current) orelse return if (eql(u8, current, name)) null else current;
        current = found.underlying;
    }
}

const Stripped = struct { core: []const u8, had_const: bool };

fn stripQualifiers(a: Allocator, spelled: []const u8) Stripped {
    var out = spelled;
    for ([_][]const u8{ "const", "volatile", "restrict", "__restrict" }) |word| out = text.blankWord(a, out, word);
    return .{ .core = collapseSpaces(a, out), .had_const = text.hasWord(spelled, "const") };
}

/// Function pointers are excluded before this runs: their parens hold stars that are not depth.
fn splitPointer(a: Allocator, spelling: []const u8) struct { base: []const u8, depth: usize } {
    const blanked = a.dupe(u8, spelling) catch oom();
    std.mem.replaceScalar(u8, blanked, '*', ' ');
    return .{ .base = collapseSpaces(a, blanked), .depth = std.mem.countScalar(u8, spelling, '*') };
}

/// `tag.replace(/[^A-Za-z0-9_]/g, '_')` runs per UTF-16 unit, so an astral letter is two.
fn brandAlias(a: Allocator, tag: []const u8) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    out.appendSlice(a, "Ptr_") catch oom();
    var i: usize = 0;
    while (i < tag.len) {
        const b = tag[i];
        if (text.isWordByte(b)) {
            out.append(a, b) catch oom();
            i += 1;
            continue;
        }
        const len: usize = std.unicode.utf8ByteSequenceLength(b) catch 1;
        out.appendSlice(a, if (len == 4) "__" else "_") catch oom();
        i += len;
    }
    if (out.items.len == "Ptr_".len) out.appendSlice(a, "anon") catch oom();
    return out.items;
}

const Flags = struct { is_union: bool, has_bitfield: bool };

fn recordFlags(model: *const HeaderModel, name: []const u8) ?Flags {
    var flags: Flags = .{ .is_union = false, .has_bitfield = false };
    var found = false;
    var records = model.records_by_id.valueIterator();
    while (records.next()) |record| {
        const named = record.name orelse continue;
        if (!record.complete or !eql(u8, named, name)) continue;
        found = true;
        if (record.tag == .@"union") flags.is_union = true;
        if (record.has_bitfield) flags.has_bitfield = true;
    }
    if (found) return flags;
    // `typedef struct {...} Point`: the elaborated spelling reads `struct Point` with no named
    // record, so the typedef's owned tag answers.
    const alias = model.typedefs.get(name) orelse return null;
    const anon = model.records_by_id.get(alias.anon_tag_id orelse return null) orelse return null;
    return if (anon.complete) .{ .is_union = anon.tag == .@"union", .has_bitfield = anon.has_bitfield } else null;
}

fn unionRefusal(a: Allocator, spelled: []const u8) AbiResult {
    return refuse("union", fmt(a, "union '{s}' has no ABI row (docs/FFI.md)", .{spelled}), "STA1119");
}

fn unknownType(a: Allocator, core: []const u8) AbiResult {
    return refuse("unknown type", fmt(a, "unknown type '{s}' — no typedef or tag declaration in scope", .{core}), "STA1119");
}

fn unterminated(a: Allocator, core: []const u8) AbiResult {
    return refuse("unknown type", fmt(a, "unknown type '{s}' — typedef resolution did not terminate", .{core}), "STA1119");
}

fn byValue(a: Allocator, core: []const u8) AbiResult {
    return refuse("struct by value", fmt(a, "struct '{s}' by value has no ABI row — by pointer only (docs/FFI.md §2)", .{core}), "STA1119");
}

fn mapStructPointee(a: Allocator, model: *const HeaderModel, name: []const u8, spelled: []const u8) AbiResult {
    // A bare anonymous struct names no brand a `.d.ts` could share, and each occurrence is a
    // distinct C type.
    if (!text.isCIdentifier(name))
        return refuse("anonymous struct", fmt(a, "anonymous struct '{s}' has no nameable brand — put it behind a typedef", .{spelled}), "STA1119");
    if (recordFlags(model, name)) |flags| {
        if (flags.is_union) return unionRefusal(a, spelled);
        if (flags.has_bitfield)
            return refuse("bitfield struct", fmt(a, "struct '{s}' contains bitfields, which v0 cannot lay out", .{spelled}), "STA1119");
    }
    // Opaque or merely declared: generated code never dereferences it, so a definition is not
    // needed (docs/FFI.md §2).
    return pointer(a, name);
}

/// `via` counts typedef re-entries, so a redefined typedef cannot loop.
fn mapPointee(a: Allocator, model: *const HeaderModel, base: []const u8, position: Position, via: u32) AbiResult {
    const stripped = stripQualifiers(a, base);
    const core = stripped.core;
    if (eql(u8, core, "char") or eql(u8, core, "unsigned char") or eql(u8, core, "signed char")) {
        if (stripped.had_const or position == .@"return") return primitive(.cstring, null);
        return refuse("mutable char* buffer", fmt(a, "mutable '{s}*' buffer parameter has no ABI row — only borrowed CString in, copied CString out (docs/FFI.md §3)", .{core}), "STA1119");
    }
    if (eql(u8, core, "void")) {
        if (position == .param) return pointer(a, "void");
        return refuse("void* return", "`void*` return has no ABI row — no allocator-return spelling exists in v0 (docs/FFI.md §3)", "STA1119");
    }
    if (startsWith(u8, core, "struct ")) return mapStructPointee(a, model, core["struct ".len..], core);
    if (startsWith(u8, core, "union ")) return unionRefusal(a, core);
    if (startsWith(u8, core, "enum ")) return pointer(a, core["enum ".len..]);
    if (floats.has(core) or bools.has(core) or int32.has(core) or int64.has(core) or eql(u8, core, "size_t") or eql(u8, core, "ssize_t"))
        return refuse("scalar pointer", fmt(a, "scalar pointer '{s}*' is an out-param/array shape with no ABI row (docs/FFI.md)", .{core}), "STA1119");
    if (text.isCIdentifier(core)) {
        const resolved = resolveTypedef(a, core, model) orelse return unknownType(a, core);
        // A bare name that resolves to itself is an undeclared tag used sugar-free.
        if (eql(u8, resolved, core)) return unknownType(a, core);
        if (via > 16) return unterminated(a, core);
        if (std.mem.indexOfAny(u8, resolved, "*([") != null) {
            // The chain hides declarator depth: `typedef Node *NodePtr` used as `NodePtr *` is two
            // stars, so the consumed star goes back on and the total depth decides.
            return mapCTypeInner(a, fmt(a, "{s} *", .{resolved}), model, position, via + 1);
        }
        return mapPointee(a, model, resolved, position, via + 1);
    }
    return refuse("unsupported type", fmt(a, "type '{s}*' is outside the ABI table (docs/FFI.md)", .{core}), "STA1119");
}

fn mapScalar(a: Allocator, model: *const HeaderModel, core: []const u8, position: Position, via: u32) AbiResult {
    if (eql(u8, core, "void")) {
        if (position == .@"return") return primitive(.void, null);
        return refuse("void parameter", "`void` as a parameter is outside the ABI table — return position only", "STA1119");
    }
    if (floats.has(core)) return primitive(.number, null);
    if (bools.has(core)) return primitive(.boolean, null);
    if (int32.has(core)) return primitive(.number, .int);
    if (int64.has(core) or endsWith(u8, core, "64_t"))
        return refuse("64-bit integer", fmt(a, "64-bit integer '{s}' has no ABI row — 'number' cannot hold every int64 exactly (NOTES.md \"int64\")", .{core}), "STA1119");
    if (eql(u8, core, "size_t") or eql(u8, core, "ssize_t")) return primitive(.number, .size);
    if (eql(u8, core, "va_list") or eql(u8, core, "__builtin_va_list"))
        return refuse("va_list", "`va_list` parameter is varargs machinery with no ABI row", "STA1119");
    if (startsWith(u8, core, "struct ")) return byValue(a, core);
    if (startsWith(u8, core, "union ")) return unionRefusal(a, core);
    if (startsWith(u8, core, "enum ")) return primitive(.number, .int);
    if (text.isCIdentifier(core)) {
        if (model.typedefs.get(core)) |alias| {
            if (alias.anon_tag_id) |id| {
                if (model.records_by_id.get(id)) |anon| {
                    if (anon.tag == .@"union") return unionRefusal(a, core);
                }
            }
        }
        const resolved = resolveTypedef(a, core, model);
        if (resolved == null or eql(u8, resolved.?, core)) {
            // `FILE`-style: used but never declared in the dump's reach.
            var records = model.records_by_id.valueIterator();
            while (records.next()) |record| {
                const named = record.name orelse continue;
                if (eql(u8, named, core)) return byValue(a, core);
            }
            return unknownType(a, core);
        }
        if (via > 16) return unterminated(a, core);
        // `typedef const char *sqlite3_filename`: a starless use-site spelling is no proof of a
        // scalar, so the resolved spelling gets the full analysis.
        return mapCTypeInner(a, resolved.?, model, position, via + 1);
    }
    return refuse("unsupported type", fmt(a, "type '{s}' is outside the ABI table (docs/FFI.md)", .{core}), "STA1119");
}

/// `spelling.replace(/\*\s*((?:const|volatile|restrict|__restrict)\s*)+$/, '*')`: a qualifier after
/// the star qualifies the pointer. Left in, `char * const` would read as `char const` and pass the
/// `const char` rule.
fn dropPointerQualifiers(spelling: []const u8) []const u8 {
    const star = std.mem.lastIndexOfScalar(u8, spelling, '*') orelse return spelling;
    var at = text.skipSpaces(spelling, star + 1);
    var seen = false;
    outer: while (at < spelling.len) {
        for ([_][]const u8{ "const", "volatile", "restrict", "__restrict" }) |word| {
            if (startsWith(u8, spelling[at..], word)) {
                at = text.skipSpaces(spelling, at + word.len);
                seen = true;
                continue :outer;
            }
        }
        return spelling;
    }
    if (!seen) return spelling;
    return spelling[0 .. star + 1];
}

/// Structural refusals come before the kind mapping, the gate's order (`extern.ts`).
pub fn mapCType(a: Allocator, c_type: []const u8, model: *const HeaderModel, position: Position) AbiResult {
    return mapCTypeInner(a, c_type, model, position, 0);
}

fn mapCTypeInner(a: Allocator, c_type: []const u8, model: *const HeaderModel, position: Position, via: u32) AbiResult {
    const spelling = collapseSpaces(a, c_type);
    if (std.mem.indexOf(u8, spelling, "(*)") != null or std.mem.indexOf(u8, spelling, "(^") != null)
        return refuse("function pointer", "function pointer has no ABI row — v0 has no closure trampoline", "STA1117");
    if (std.mem.indexOfScalar(u8, spelling, '&') != null)
        return refuse("C++ reference", fmt(a, "C++ reference '{s}' is outside the C ABI table", .{spelling}), "STA1119");
    if (std.mem.indexOfScalar(u8, spelling, '[') != null)
        return refuse("array type", fmt(a, "array type '{s}' has no ABI row — pass a pointer and a length", .{spelling}), "STA1116");
    for ([_][]const u8{ "_Complex", "__complex__", "_Imaginary", "__int128" }) |word| {
        if (text.hasWord(spelling, word))
            return refuse("complex type", fmt(a, "type '{s}' is outside the ABI table (docs/FFI.md)", .{spelling}), "STA1119");
    }
    const declarator = collapseSpaces(a, dropPointerQualifiers(spelling));
    const split = splitPointer(a, declarator);
    const base = split.base;
    if (split.depth >= 2) {
        // A `T*` pointing at a branded pointer in parameter position is the out-param spelling
        // (`Out<Brand>`, docs/FFI.md §2).
        if (split.depth == 2 and position == .param) {
            switch (mapPointee(a, model, base, position, via)) {
                .ok => |inner| switch (inner) {
                    .pointer => |brand| return .{ .ok = .{ .out_param = brand } },
                    .primitive => |p| if (p.ts == .cstring) {
                        // `const char **`: the callee writes a borrowed pointer and the caller
                        // copies on read. Mutable `char **` is a different contract no row covers.
                        return .{ .ok = .{ .out_param = .{ .alias = "CString", .tag = "char" } } };
                    },
                    .out_param => {},
                },
                .refused => |refusal| return refuse("T** out-param", fmt(a, "'{s}' is a T** out-param whose pointee is not a branded pointer — {s}", .{ spelling, refusal.reason }), "STA1119"),
            }
            return refuse("T** out-param", fmt(a, "'{s}' is a T** out-param whose pointee '{s} *' is not a branded pointer — CString crosses by borrow/copy, never by out-param (docs/FFI.md §3)", .{ spelling, collapseSpaces(a, base) }), "STA1119");
        }
        if (position == .@"return")
            return refuse("T** out-param", fmt(a, "'{s}' is a T** out-param in return position — Out<T> is a parameter-only spelling (docs/FFI.md §2)", .{spelling}), "STA1119");
        return refuse("T** out-param", fmt(a, "'{s}' is a T*** (or deeper) out-param with no ABI row — only a single T** maps to Out<T> (docs/FFI.md §2)", .{spelling}), "STA1119");
    }
    // Const-ness that matters lives inside the base, so the base goes in with its qualifiers.
    if (split.depth == 1) return mapPointee(a, model, base, position, via);
    return mapScalar(a, model, stripQualifiers(a, spelling).core, position, via);
}

pub const Ownership = enum { value, borrow, pointer, out };
pub const RetOwnership = enum { value, copy_out, handle, none };

pub const MappedParam = struct {
    ts_name: []const u8,
    ts_type: []const u8,
    ownership: Ownership,
    brand: ?BrandRef,
    /// Why this position widens to `number`.
    c_note: ?CNote,
};

pub const MappedFunction = struct {
    c_name: []const u8,
    ts_name: []const u8,
    line: u32,
    c_signature: []const u8,
    params: []const MappedParam,
    ret: []const u8,
    ret_brand: ?BrandRef,
    ret_note: ?CNote,
    ret_ownership: RetOwnership,
    needs_cstring: bool,
};

/// `construct` is the declaration's name, as the summary and the diff report it.
pub const Refusal = struct { line: u32, construct: []const u8, kind: []const u8, reason: []const u8, code: ?[]const u8 };

pub const FunctionMapping = union(enum) { ok: MappedFunction, refused: Refusal };

const ts_reserved = setOf(&.{
    "break",     "case",     "catch",   "class",     "const",  "continue",   "debugger", "default",
    "delete",    "do",       "else",    "enum",      "export", "extends",    "false",    "finally",
    "for",       "function", "if",      "import",    "in",     "instanceof", "new",      "null",
    "return",    "super",    "switch",  "this",      "throw",  "true",       "try",      "typeof",
    "var",       "void",     "while",   "with",      "yield",  "let",        "static",   "implements",
    "interface", "package",  "private", "protected", "public", "type",       "declare",
});

/// Mechanical camelCase, no prefix guessing.
pub fn tsFunctionName(a: Allocator, c_name: []const u8) []const u8 {
    var parts = std.mem.tokenizeScalar(u8, c_name, '_');
    const head = parts.next() orelse return "fn";
    var base: std.ArrayList(u8) = .empty;
    base.appendSlice(a, head) catch oom();
    while (parts.next()) |part| base.appendSlice(a, text.upperFirst(a, part)) catch oom();
    const first = base.items[0];
    const candidate = if (text.isIdentifierStart(first) or first == '$') base.items else std.mem.concat(a, u8, &.{ "_", base.items }) catch oom();
    return if (ts_reserved.has(candidate)) fmt(a, "{s}Fn", .{candidate}) else candidate;
}

pub const Names = std.StringHashMapUnmanaged(void);

fn tsParamName(a: Allocator, c_name: ?[]const u8, index: usize, taken: *const Names) []const u8 {
    const raw = if (c_name != null and text.isCIdentifier(c_name.?) and !ts_reserved.has(c_name.?)) c_name.? else fmt(a, "p{d}", .{index});
    if (!taken.contains(raw)) return raw;
    var suffix: usize = 2;
    while (true) : (suffix += 1) {
        const name = fmt(a, "{s}{d}", .{ raw, suffix });
        if (!taken.contains(name)) return name;
    }
}

fn tsSpelling(a: Allocator, value: AbiOk) []const u8 {
    return switch (value) {
        .primitive => |p| switch (p.ts) {
            .number => "number",
            .boolean => "boolean",
            .void => "void",
            .cstring => "CString",
        },
        .out_param => |brand| fmt(a, "Out<{s}>", .{brand.alias}),
        .pointer => |brand| brand.alias,
    };
}

fn brandOf(value: AbiOk) ?BrandRef {
    return switch (value) {
        .primitive => null,
        // `Out<CString>` names no handle: the shared `CString` alias is its only declaration.
        .out_param => |brand| if (eql(u8, brand.alias, "CString")) null else brand,
        .pointer => |brand| brand,
    };
}

fn noteOf(value: AbiOk) ?CNote {
    return if (value == .primitive) value.primitive.c_note else null;
}

fn ownershipOf(value: AbiOk) Ownership {
    return switch (value) {
        .primitive => |p| if (p.ts == .cstring) .borrow else .value,
        .out_param => .out,
        .pointer => .pointer,
    };
}

fn retOwnershipOf(value: AbiOk) RetOwnership {
    return switch (value) {
        .primitive => |p| switch (p.ts) {
            .cstring => .copy_out,
            .void => .none,
            else => .value,
        },
        else => .handle,
    };
}

fn cSignature(a: Allocator, fn_: *const CFunction) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    out.appendSlice(a, collapseSpaces(a, fn_.return_type)) catch oom();
    out.appendSlice(a, " (") catch oom();
    for (fn_.params, 0..) |param, i| {
        if (i != 0) out.appendSlice(a, ", ") catch oom();
        out.appendSlice(a, collapseSpaces(a, param.c_type)) catch oom();
    }
    out.append(a, ')') catch oom();
    return out.items;
}

/// Function-level refusals, then parameters left to right, then the return: the gate's order, so
/// one signature earns one diagnostic.
pub fn classifyFunction(a: Allocator, fn_: *const CFunction, model: *const HeaderModel, taken: *Names) FunctionMapping {
    const Local = struct {
        fn refused(f: *const CFunction, kind: []const u8, reason: []const u8, code: ?[]const u8) FunctionMapping {
            return .{ .refused = .{ .construct = f.c_name, .line = f.line, .kind = kind, .reason = reason, .code = code } };
        }
    };
    if (fn_.variadic) return Local.refused(fn_, "variadic", "variadic (`printf`-style) function has no sound signature", "STA1120");
    if (fn_.is_inline) return Local.refused(fn_, "inline function", "inline function lives in the header, not in the linked library", "STA1119");
    if (fn_.has_body) return Local.refused(fn_, "header-local definition", "function defined in the header (a body, not a declaration) is header-local", "STA1119");
    if (fn_.is_static) return Local.refused(fn_, "static function", "`static` function has internal linkage — no C symbol to bind", "STA1119");
    const ts_name = tsFunctionName(a, fn_.c_name);
    if (taken.contains(ts_name)) return Local.refused(fn_, "name collision", fmt(a, "TS name '{s}' collides with another generated declaration", .{ts_name}), "STA1119");
    taken.put(a, ts_name, {}) catch oom();
    var params: std.ArrayList(MappedParam) = .empty;
    var used: Names = .empty;
    for (fn_.params, 0..) |param, index| {
        const value = switch (mapCType(a, param.c_type, model, .param)) {
            .refused => |refusal| return Local.refused(fn_, refusal.kind, fmt(a, "parameter {d} ('{s}'): {s}", .{ index + 1, collapseSpaces(a, param.c_type), refusal.reason }), refusal.code),
            .ok => |ok| ok,
        };
        const name = tsParamName(a, param.name, index, &used);
        used.put(a, name, {}) catch oom();
        params.append(a, .{ .ts_name = name, .ts_type = tsSpelling(a, value), .ownership = ownershipOf(value), .brand = brandOf(value), .c_note = noteOf(value) }) catch oom();
    }
    const ret = switch (mapCType(a, fn_.return_type, model, .@"return")) {
        .refused => |refusal| return Local.refused(fn_, refusal.kind, fmt(a, "return ('{s}'): {s}", .{ collapseSpaces(a, fn_.return_type), refusal.reason }), refusal.code),
        .ok => |ok| ok,
    };
    const spelled = tsSpelling(a, ret);
    var needs_cstring = eql(u8, spelled, "CString");
    for (params.items) |p| {
        if (eql(u8, p.ts_type, "CString") or eql(u8, p.ts_type, "Out<CString>")) needs_cstring = true;
    }
    return .{ .ok = .{
        .c_name = fn_.c_name,
        .ts_name = ts_name,
        .line = fn_.line,
        .c_signature = cSignature(a, fn_),
        .params = params.items,
        .ret = spelled,
        .ret_brand = brandOf(ret),
        .ret_note = noteOf(ret),
        .ret_ownership = retOwnershipOf(ret),
        .needs_cstring = needs_cstring,
    } };
}
