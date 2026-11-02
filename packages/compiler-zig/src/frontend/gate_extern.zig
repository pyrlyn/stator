//! The extern boundary: `@statorExtern` declarations, their ABI table and the link pragmas. stator-ts
//! parses no JSDoc, so the tags are read from the source text the checker holds.

const std = @import("std");
const project = @import("stator_ts").project;
const api = @import("gate_api.zig");
const types = @import("gate_types.zig");
const N = @import("../hir/nodes.zig");
const H = @import("../hir/types.zig");
const support = @import("../support/root.zig");
const isCIdentifier = support.names.isCIdentifier;
const ast_walk = support.ast_walk;
const jsdoc = @import("../ffigen/jsdoc.zig");
const report = support.diagnostics;
const Gate = api.Gate;
const Node = api.Node;
const Refusal = api.Refusal;
const Result = api.Result;
const Symbol = api.Symbol;
const Type = api.Type;
const F = api.F;
const accept = api.accept;
const eql = api.eql;
const oom = api.oom;
const AbiKind = N.ExternAbiKind;

pub const Signature = struct {
    ts_name: []const u8,
    c_name: []const u8,
    params: []const AbiKind,
    ret: AbiKind,
    @"error": ?N.ExternErrorConvention,
};

pub const Classified = union(enum) {
    ok: Signature,
    refused: Refusal,
};

const Position = enum { param, @"return" };

const Marker = struct { c_name: ?[]const u8, errors: []const []const u8 };

fn isBlank(b: u8) bool {
    return b == ' ' or b == '\t' or b == '\r' or b == '\n' or b == 0x0b or b == 0x0c;
}

fn trim(s: []const u8) []const u8 {
    return std.mem.trim(u8, s, " \t\r\n\x0b\x0c");
}

fn jsdocTags(g: *Gate, node: *Node) []const jsdoc.Tag {
    const file = g.fileOf(node) orelse return &.{};
    if (std.mem.indexOf(u8, file.src, "@stator") == null) return &.{};
    const body = jsdoc.jsdocBefore(file.src, node.start) orelse return &.{};
    return jsdoc.tags(g.a, body);
}

fn markerOf(g: *Gate, declaration: *Node) ?Marker {
    var found = false;
    var c_name: ?[]const u8 = null;
    var errors: std.ArrayList([]const u8) = .empty;
    for (jsdocTags(g, declaration)) |tag| {
        if (eql(tag.name, "statorExtern")) {
            found = true;
            if (c_name == null) c_name = jsdoc.firstWord(tag.comment);
        } else if (eql(tag.name, "statorError")) {
            errors.append(g.a, jsdoc.text.trim(tag.comment)) catch oom();
        }
    }
    return if (found) .{ .c_name = c_name, .errors = errors.items } else null;
}

pub fn isExternDeclaration(g: *Gate, node: *Node) bool {
    return api.isFunctionDeclaration(node) and markerOf(g, node) != null;
}

pub fn externDeclarationOfSymbol(g: *Gate, symbol: ?*Symbol) ?*Node {
    const s = symbol orelse return null;
    for (s.decls) |declaration| if (isExternDeclaration(g, declaration)) return declaration;
    for (s.decls) |declaration| {
        if (declaration.data != .import_spec and declaration.data != .export_spec) continue;
        const target = g.aliased(s) orelse return null;
        for (target.decls) |d| if (isExternDeclaration(g, d)) return d;
        return null;
    }
    return null;
}

fn calleeOf(identifier: *Node) ?*Node {
    var current = identifier;
    while (current.parent) |parent| {
        if (parent.data != .paren) return if (parent.data == .call and parent.data.call.callee == current) parent else null;
        current = parent;
    }
    return null;
}

pub fn isOutSlotCallee(g: *Gate, node: *Node) bool {
    const call = calleeOf(node) orelse return false;
    if (call.data.call.optional) return false;
    return outSlotDeclarationOf(g, call) != null;
}

pub fn isDirectCalleePosition(node: *Node) bool {
    return calleeOf(node) != null;
}

/// The callee when it is a bare name, the only callee that can name an extern or `outSlot`.
fn namedCallee(call: *Node) ?*Node {
    const callee = api.skipParens(call.data.call.callee);
    return if (api.isIdentifier(callee)) callee else null;
}

pub fn externDeclarationOfCall(g: *Gate, call: *Node) ?*Node {
    return externDeclarationOfSymbol(g, g.symbolAt(namedCallee(call) orelse return null));
}

const CStringKind = enum { cstring, cstring_owned, invalid };

fn cstringKindOf(t: *Type) ?CStringKind {
    const alias = t.alias orelse return null;
    const owned = eql(alias.sym.name, "CStringOwned");
    if (!owned and !eql(alias.sym.name, "CString")) return null;
    const kind: CStringKind = if (owned) .cstring_owned else .cstring;
    if (api.isStringLike(t)) return kind;
    if (t.data == .inter) {
        for (t.data.inter) |part| if (api.isStringLike(part)) return kind;
    }
    return .invalid;
}

pub fn outInnerTag(g: *Gate, t: *Type) ?[]const u8 {
    if (!types.isOutAlias(t)) return null;
    const inner = types.outSlotInner(g, t) orelse return null;
    if (!types.isBrandedPointer(g, inner)) return "char";
    const props = g.properties(inner);
    if (props.len == 0) return null;
    const literal = g.propType(props[0]);
    return if (literal.data == .str_lit) literal.data.str_lit else null;
}

pub fn outSlotDeclarationOf(g: *Gate, call: *Node) ?*Node {
    const callee = namedCallee(call) orelse return null;
    if (!api.identifierIs(callee, "outSlot")) return null;
    const decl = api.valueDeclaration(g.symbolAt(callee)) orelse return null;
    if (!api.isFunctionDeclaration(decl)) return null;
    const f = decl.data.func;
    if (f.body != null or f.params.len != 0) return null;
    const ret = if (f.ret) |r| g.typeFromNode(r) else g.returnType(g.signatureOf(decl));
    return if (types.isOutAlias(ret)) decl else null;
}

const missing_slot = "outSlot() needs a slot type — outSlot<Db>() or an Out<Db> annotation (docs/FFI.md)";

fn outSlotCallIsTyped(g: *Gate, call: *Node) bool {
    if (g.resolvedSignature(call)) |signature| {
        if (types.outSlotInner(g, g.returnType(signature)) != null) return true;
    }
    const parent = call.parent orelse return false;
    if (parent.data != .var_decl) return false;
    const x = parent.data.var_decl;
    const declared = if (x.type) |annotation| g.typeFromNode(annotation) else g.typeAt(x.name);
    return types.outSlotInner(g, declared) != null;
}

fn Refusing(comptime T: type) type {
    return struct {
        fn make(code: []const u8, message: []const u8) T {
            return .{ .refused = .{ .code = code, .message = message } };
        }
    };
}

const refused = Refusing(Classified).make;

const PositionResult = union(enum) {
    kind: AbiKind,
    refused: Refusal,
};

fn kindOf(kind: AbiKind) PositionResult {
    return .{ .kind = kind };
}

const refuse = Refusing(PositionResult).make;

fn classifyPosition(g: *Gate, t: *Type, position: Position) PositionResult {
    if (cstringKindOf(t)) |kind| switch (kind) {
        .cstring => return kindOf(.cstring),
        .cstring_owned => return if (position == .param)
            kindOf(.@"cstring-owned")
        else
            refuse("STA1119", "CStringOwned as a return is outside the ABI table (docs/FFI.md) — a returned pointer the runtime must free has no known allocator"),
        .invalid => return refuse("STA1119", "CString in an extern signature must brand 'string' (docs/FFI.md)"),
    };
    if (types.isBrandedPointer(g, t)) return kindOf(.pointer);
    if (types.isOutAlias(t)) {
        if (types.outSlotInner(g, t) == null) {
            return refuse("STA1125", "`Out<T>` needs a branded-pointer or CString inner in an extern signature (docs/FFI.md) — anything else has no `T**` to pass");
        }
        if (position != .param) {
            return refuse("STA1119", "`Out<T>` as a return is outside the ABI table (docs/FFI.md) — a returned slot address would die with the call");
        }
        return kindOf(.@"out-pointer");
    }
    const mapped = types.tsTypeToHType(g, t);
    return switch (mapped.*) {
        .number => kindOf(.number),
        .boolean => kindOf(.boolean),
        .undefined => if (position == .@"return") kindOf(.void) else refuse("STA1119", "void as a parameter is outside the ABI table (docs/FFI.md) — return position only"),
        .string => refuse("STA1118", "string in an extern signature has no direct C mapping; use CString (borrow) or CStringOwned (transfer) (docs/FFI.md)"),
        .unknown => refuse("STA1114", "unknown in an extern signature has no C representation; use a type from the ABI table (docs/FFI.md)"),
        .object => refuse("STA1115", "object type in an extern signature has no C representation; use a branded pointer or CString (docs/FFI.md)"),
        .uint8array => if (position == .param) kindOf(.bytes) else refuse("STA1119", "Uint8Array as a return is outside the ABI table (docs/FFI.md) — pass a Uint8Array in and let the callee fill it"),
        .array => refuse("STA1116", "array type in an extern signature has no C representation; pass a pointer and a length as ABI types (docs/FFI.md)"),
        .@"fn" => refuse("STA1117", "function type in an extern signature has no C representation; v0 has no closure trampoline (docs/FFI.md)"),
        else => refuse("STA1119", g.fmt("{s} in an extern signature is outside the ABI table (docs/FFI.md)", .{H.hTypeName(g.a, mapped) catch oom()})),
    };
}

const concurrency_symbols = [_][]const u8{
    "jsrt_thread_spawn",
    "jsrt_thread_join",
    "jsrt_thread_run_on_main",
    "jsrt_sync_mutex_new",
    "jsrt_sync_mutex_lock",
    "jsrt_sync_mutex_try_lock",
    "jsrt_sync_mutex_unlock",
    "jsrt_sync_mutex_destroy",
    "jsrt_sync_cond_new",
    "jsrt_sync_cond_wait",
    "jsrt_sync_cond_signal",
    "jsrt_sync_cond_destroy",
    "jsrt_sync_channel_new",
    "jsrt_sync_channel_send",
    "jsrt_sync_channel_receive",
    "jsrt_sync_channel_close",
};

fn concurrencyPosition(g: *Gate, t: *Type, position: Position) PositionResult {
    const mapped = types.tsTypeToHType(g, t);
    return if (mapped.* == .unknown or mapped.* == .@"fn") kindOf(.value) else classifyPosition(g, t, position);
}

fn isConcurrencyDeclaration(g: *Gate, decl: *Node, c_name: []const u8) bool {
    const file = g.fileOf(decl) orelse return false;
    if (!eql(file.path, g.fmt("{s}/native/concurrency.d.ts", .{g.paths.?.std_package.source_dir}))) return false;
    for (concurrency_symbols) |symbol| if (eql(symbol, c_name)) return true;
    return false;
}

pub fn headerOf(g: *Gate, file: *api.File) ?[]const u8 {
    var header: ?[]const u8 = null;
    var count: usize = 0;
    for (linkPragmasOf(g, file)) |pragma| {
        if (pragma.kind == .header) {
            header = pragma.kind.header;
            count += 1;
        }
    }
    return if (count == 1) header else null;
}

pub fn classifyExternDeclaration(g: *Gate, decl: *Node) Classified {
    const marker = markerOf(g, decl) orelse Marker{ .c_name = null, .errors = &.{} };
    const f = decl.data.func;
    const ts_name = if (f.name) |name| api.text(name) orelse "anonymous" else "anonymous";
    const c_name = marker.c_name orelse ts_name;
    if (!isCIdentifier(c_name)) return refused("STA1119", g.fmt("'{s}' is not a C identifier, so it names no C symbol (docs/FFI.md)", .{c_name}));
    for (f.params) |param| {
        if (param.data.param.dotdotdot) {
            return refused("STA1120", "variadic extern declaration is not supported — each call site is a different function type (docs/FFI.md)");
        }
    }
    const classify = if (isConcurrencyDeclaration(g, decl, c_name)) &concurrencyPosition else &classifyPosition;
    const params = g.a.alloc(AbiKind, f.params.len) catch oom();
    for (f.params, params) |param, *slot| switch (classify(g, g.typeAt(param), .param)) {
        .kind => |kind| slot.* = kind,
        .refused => |r| return .{ .refused = r },
    };
    const file = g.fileOf(decl);
    if (file != null and headerOf(g, file.?) != null) {
        for (f.params) |param| {
            const t = g.typeAt(param);
            if (types.outSlotInner(g, t) == null) continue;
            const tag = outInnerTag(g, t) orelse continue;
            if (eql(tag, "char") or isCIdentifier(tag)) continue;
            return refused("STA1125", g.fmt("Out parameter '{s}' names a brand the header cast cannot spell — the __brand literal must be a C identifier (docs/FFI.md)", .{api.sourceText(g, param.data.param.name)}));
        }
    }
    const ret = switch (classify(g, g.returnType(g.signatureOf(decl)), .@"return")) {
        .kind => |kind| kind,
        .refused => |r| return .{ .refused = r },
    };
    var convention_kind: ?N.ExternErrorConvention = null;
    if (marker.errors.len > 1) return refused("STA1119", "one @statorError convention per declaration; a combination is outside the ABI table (docs/FFI.md)");
    if (marker.errors.len == 1) {
        const convention = marker.errors[0];
        const known = std.meta.stringToEnum(N.ExternErrorConvention, convention) orelse {
            return refused("STA1119", g.fmt("unknown error convention '{s}'; the closed set is nonzero, negative, null, errno (docs/FFI.md)", .{convention}));
        };
        if (N.externConventionMismatch(g.a, ret, known) catch oom()) |mismatch| {
            return refused("STA1119", g.fmt("{s} (docs/FFI.md)", .{mismatch}));
        }
        convention_kind = known;
    }
    return .{ .ok = .{ .ts_name = ts_name, .c_name = c_name, .params = params, .ret = ret, .@"error" = convention_kind } };
}

pub const PragmaKind = union(enum) {
    header: []const u8,
    flags: []const []const u8,
    invalid: []const u8,
};

pub const LinkPragma = struct { kind: PragmaKind, line: u32, col: u32 };

fn quoteJson(g: *Gate, s: []const u8) []const u8 {
    var out: std.Io.Writer.Allocating = .init(g.a);
    report.writeJsonString(&out.writer, s) catch oom();
    return out.written();
}

fn unspellableInInclude(s: []const u8) bool {
    return std.mem.indexOfAny(u8, s, "\"\n\r\x00") != null;
}

fn splitPragmaWords(g: *Gate, body: []const u8) ?[]const []const u8 {
    var words: std.ArrayList([]const u8) = .empty;
    var at: usize = 0;
    while (at < body.len) {
        if (isBlank(body[at])) {
            at += 1;
            continue;
        }
        if (body[at] == '"') {
            if (std.mem.indexOfScalarPos(u8, body, at + 1, '"')) |close| {
                words.append(g.a, body[at + 1 .. close]) catch oom();
                at = close + 1;
                continue;
            }
        }
        const start = at;
        while (at < body.len and !isBlank(body[at])) at += 1;
        words.append(g.a, body[start..at]) catch oom();
    }
    for (words.items) |word| if (std.mem.indexOfScalar(u8, word, '"') != null) return null;
    return words.items;
}

fn isLinkWord(word: []const u8) bool {
    if (word.len >= 3 and word[0] == '-' and (word[1] == 'l' or word[1] == 'L')) return true;
    if (!std.mem.startsWith(u8, word, "-Wl,-rpath,")) return false;
    const dir = word["-Wl,-rpath,".len..];
    return dir.len > 0 and std.mem.indexOfScalar(u8, dir, ',') == null;
}

fn linkFlagRefused(words: []const []const u8) ?[]const u8 {
    var index: usize = 0;
    while (index < words.len) : (index += 1) {
        const word = words[index];
        if (eql(word, "-framework")) {
            if (index + 1 >= words.len or std.mem.startsWith(u8, words[index + 1], "-")) return word;
            index += 1;
        } else if (!isLinkWord(word)) {
            return word;
        }
    }
    return null;
}

fn includeTarget(text: []const u8) ?struct { name: []const u8, quoted: bool } {
    const body = std.mem.trimStart(u8, text, " \t\r\x0b\x0c");
    if (!std.mem.startsWith(u8, body, "#include")) return null;
    const rest = body["#include".len..];
    if (rest.len == 0 or !isBlank(rest[0])) return null;
    const inner = trim(rest);
    if (inner.len < 3) return null;
    if (inner[0] == '"' and inner[inner.len - 1] == '"') {
        const name = inner[1 .. inner.len - 1];
        return if (std.mem.indexOfScalar(u8, name, '"') == null) .{ .name = name, .quoted = true } else null;
    }
    if (inner[0] == '<' and inner[inner.len - 1] == '>') {
        const name = inner[1 .. inner.len - 1];
        return if (std.mem.indexOfAny(u8, name, "<>") == null) .{ .name = inner, .quoted = false } else null;
    }
    return null;
}

fn parseLinkPragmaBody(g: *Gate, body: []const u8, file_dir: []const u8) PragmaKind {
    var text = std.mem.trimStart(u8, body, " \t\r\x0b\x0c");
    if (text.len > 0 and text[0] == ':') text = std.mem.trimStart(u8, text[1..], " \t\r\x0b\x0c") else text = body;
    if (includeTarget(text)) |target| {
        if (target.quoted) {
            const path = if (std.mem.indexOfScalar(u8, target.name, '/') != null)
                std.fs.path.resolve(g.a, &.{ file_dir, target.name }) catch oom()
            else
                target.name;
            if (unspellableInInclude(path)) {
                return .{ .invalid = g.fmt("the header path {s} holds a quote, a line break or NUL, which no #include can spell (docs/FFI.md)", .{quoteJson(g, path)}) };
            }
            return .{ .header = g.fmt("\"{s}\"", .{path}) };
        }
        if (unspellableInInclude(target.name)) {
            return .{ .invalid = g.fmt("the header {s} holds a line break or NUL (docs/FFI.md)", .{quoteJson(g, target.name)}) };
        }
        return .{ .header = target.name };
    }
    const words = splitPragmaWords(g, text) orelse return .{ .invalid = "an unterminated \" leaves the pragma without an end (docs/FFI.md)" };
    if (words.len == 0) return .{ .invalid = "a bare marker names nothing — give link flags or #include \"header\" (docs/FFI.md)" };
    if (words[0].len > 0 and words[0][0] == '#') {
        return .{ .invalid = g.fmt("unknown directive '{s}' — the only one is #include (docs/FFI.md)", .{words[0]}) };
    }
    if (linkFlagRefused(words)) |word| {
        return .{ .invalid = g.fmt("'{s}' is not a link flag a pragma may carry — only -l<name>, -L<dir>, -framework <name> and -Wl,-rpath,<dir>; pass anything else with --link= (docs/FFI.md)", .{word}) };
    }
    return .{ .flags = words };
}

const marker_text = "@statorLink";

/// `^\s*//\s*@statorLink\b(.*)$`.
fn pragmaBody(line: []const u8) ?[]const u8 {
    var rest = std.mem.trimStart(u8, line, " \t\x0b\x0c");
    if (!std.mem.startsWith(u8, rest, "//")) return null;
    rest = std.mem.trimStart(u8, rest[2..], " \t\x0b\x0c");
    if (!std.mem.startsWith(u8, rest, marker_text)) return null;
    rest = rest[marker_text.len..];
    if (rest.len > 0 and (std.ascii.isAlphanumeric(rest[0]) or rest[0] == '_')) return null;
    return rest;
}

fn linkPragmasOf(g: *Gate, file: *api.File) []const LinkPragma {
    if (g.link_pragmas.get(file)) |cached| return cached;
    var found: std.ArrayList(LinkPragma) = .empty;
    if (std.mem.indexOf(u8, file.src, marker_text) != null) {
        const dir = std.fs.path.dirname(file.path) orelse ".";
        var it = std.mem.splitScalar(u8, file.src, '\n');
        var index: u32 = 0;
        while (it.next()) |raw| : (index += 1) {
            const line = if (raw.len > 0 and raw[raw.len - 1] == '\r') raw[0 .. raw.len - 1] else raw;
            const body = pragmaBody(line) orelse continue;
            const col: u32 = @intCast((std.mem.indexOf(u8, line, marker_text) orelse 0) + 1);
            found.append(g.a, .{ .kind = parseLinkPragmaBody(g, body, dir), .line = index + 1, .col = col }) catch oom();
        }
    }
    g.link_pragmas.put(g.a, file, found.items) catch oom();
    return found.items;
}

fn externStep(g: *Gate, node: *Node) ast_walk.Step {
    return if (api.isFunctionDeclaration(node) and isExternDeclaration(g, node)) .match else .descend;
}

fn fileHasExternDeclaration(g: *Gate, file: *api.File) bool {
    return ast_walk.contains(file.root, g, externStep);
}

fn pushRefusal(g: *Gate, file: *api.File, node: *Node, r: Refusal) void {
    const class: report.Class = if (r.phase == null) .never else .@"not-yet";
    const d = report.fromRange(file.path, file.src, node.start, node.end, r.code, class, g.mode, r.message, r.phase);
    g.diagnostics.append(g.a, d) catch oom();
}

const ExternWalk = struct {
    g: *Gate,
    file: *api.File,

    fn visit(s: *ExternWalk, node: *Node) void {
        const g = s.g;
        if (api.isFunctionDeclaration(node) and isExternDeclaration(g, node)) {
            switch (classifyExternDeclaration(g, node)) {
                .ok => {},
                .refused => |r| pushRefusal(g, s.file, node, r),
            }
        } else if (node.data == .var_stmt) {
            for (jsdocTags(g, node)) |tag| {
                if (eql(tag.name, "statorExtern")) {
                    pushRefusal(g, s.file, node, .{ .code = "STA1119", .message = "@statorExtern marks a function declaration only (docs/FFI.md)" });
                    break;
                }
            }
        }
        api.ast.forEachChild(node, s, visit);
    }
};

/// In program order, the order a static link reads the bindings in. A pragma in a file with no
/// extern declaration is STA1119, not a silent link.
pub fn collectLinkFlags(g: *Gate, files: []const *project.SourceFile) []const []const u8 {
    var flags: std.ArrayList([]const u8) = .empty;
    for (files) |sf| {
        if (!sf.file.is_dts or !fileHasExternDeclaration(g, sf.file)) continue;
        for (linkPragmasOf(g, sf.file)) |pragma| {
            if (pragma.kind == .flags) flags.appendSlice(g.a, pragma.kind.flags) catch oom();
        }
    }
    return flags.items;
}

fn gateLinkPragmas(g: *Gate, file: *api.File) void {
    const pragmas = linkPragmasOf(g, file);
    if (pragmas.len == 0) return;
    const refuse_at = struct {
        fn run(gate: *Gate, f: *api.File, line: u32, col: u32, message: []const u8) void {
            const d = report.fromFile(f.path, line, col, "STA1119", .never, gate.mode, message, null, null);
            gate.diagnostics.append(gate.a, d) catch oom();
        }
    }.run;
    if (!fileHasExternDeclaration(g, file)) {
        refuse_at(g, file, pragmas[0].line, pragmas[0].col, "@statorLink has no effect in a file with no @statorExtern declaration; move it to the binding file (docs/FFI.md)");
        return;
    }
    var headers: usize = 0;
    for (pragmas) |pragma| switch (pragma.kind) {
        .invalid => |reason| refuse_at(g, file, pragma.line, pragma.col, g.fmt("refused @statorLink pragma: {s}", .{reason})),
        .header => {
            headers += 1;
            if (headers > 1) refuse_at(g, file, pragma.line, pragma.col, "one @statorLink #include per declaration file; a second header names a second binding this file does not contain (docs/FFI.md)");
        },
        .flags => {},
    };
}

pub fn gateExternDeclarations(g: *Gate, file: *api.File) void {
    if (std.mem.indexOf(u8, file.src, "@stator") == null) return;
    var walk = ExternWalk{ .g = g, .file = file };
    api.ast.forEachChild(file.root, &walk, ExternWalk.visit);
    gateLinkPragmas(g, file);
}

pub fn gateOutSlotCall(g: *Gate, call: *Node) Result {
    const x = call.data.call;
    if (x.optional) return api.never("STA1125", "an optional outSlot() call is outside the out-slot contract (docs/FFI.md)");
    if (api.nodes(x.args).len != 0) return api.never("STA1125", "outSlot() takes no arguments — the slot type rides the type argument (docs/FFI.md)");
    return if (outSlotCallIsTyped(g, call)) accept else api.never("STA1125", missing_slot);
}

pub fn gateExternCall(g: *Gate, call: *Node, decl: *Node) Result {
    const file = g.fileOf(decl);
    if (file == null or !file.?.is_dts) {
        return api.never("STA1121", "extern declaration is only legal in a .d.ts file; move it there (docs/FFI.md)");
    }
    return gateExternSignature(g, call, decl);
}

fn gateExternSignature(g: *Gate, call: *Node, decl: *Node) Result {
    const args = api.nodes(call.data.call.args);
    for (args) |argument| {
        if (argument.data == .spread_elem) return api.never("STA1119", "a spread argument to an extern call is outside the ABI table (docs/FFI.md)");
    }
    const signature = switch (classifyExternDeclaration(g, decl)) {
        .ok => |s| s,
        .refused => |r| return if (r.phase == null) api.never(r.code, r.message) else api.notYetCode(r.code, r.message, r.phase),
    };
    if (g.mode == .js and args.len != signature.params.len) {
        const plural: []const u8 = if (signature.params.len == 1) "" else "s";
        return api.never("STA1119", g.fmt("extern call '{s}' takes {d} argument{s}, not {d} — C calls have fixed arity (docs/FFI.md)", .{ signature.ts_name, signature.params.len, plural, args.len }));
    }
    for (signature.params, 0..) |kind, index| {
        if (index >= args.len) continue;
        const argument = args[index];
        if (kind == .pointer) {
            const t = g.typeAt(argument);
            if (types.outSlotInner(g, t) != null and (g.mode == .js or api.isAnyFlag(t))) {
                return api.never("STA1125", g.fmt("extern call '{s}' argument {d} is an out-slot where a handle is required — read the handle through .value first (docs/FFI.md)", .{ signature.ts_name, index + 1 }));
            }
            continue;
        }
        if (kind != .@"out-pointer") continue;
        const bare = api.skipParens(argument);
        const shape_ok = api.isIdentifier(bare) or (bare.data == .call and outSlotDeclarationOf(g, bare) != null and outSlotCallIsTyped(g, bare));
        const t = g.typeAt(argument);
        const typed_ok = types.outSlotInner(g, t) != null;
        if ((shape_ok and typed_ok) or (!typed_ok and !api.isAnyFlag(t) and g.mode == .ts)) continue;
        return api.never("STA1125", g.fmt("extern call '{s}' argument {d} is not a proven out-slot — bind outSlot<T>() to a name first (docs/FFI.md)", .{ signature.ts_name, index + 1 }));
    }
    return accept;
}

pub fn nonNullishConstituents(g: *Gate, t: *Type) []const *Type {
    if (!api.isUnionType(t)) return g.a.dupe(*Type, &.{t}) catch oom();
    var out: std.ArrayList(*Type) = .empty;
    for (api.parts(g, t)) |part| {
        switch (part.data) {
            .null, .undefined, .void => {},
            else => out.append(g.a, part) catch oom(),
        }
    }
    return out.items;
}

pub fn singleClassMethod(g: *Gate, live: []const *Type, name: []const u8) ?*Node {
    var found: ?*Node = null;
    for (live) |constituent| {
        if (api.isAnyFlag(constituent) or constituent.data == .unknown) return null;
        const declaration = types.classDeclarationOf(constituent) orelse return null;
        if (declaration.data.class.name == null or declaration.data.class.type_params.items.len > 0) return null;
        if (found != null and found.? != declaration) return null;
        found = declaration;
    }
    const class = found orelse return null;
    return if (types.methodDeclaringClass(g, class, name) == null) null else class;
}
