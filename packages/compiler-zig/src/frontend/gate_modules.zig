//! The module questions the gate asks: what `frontend/modules.ts`, `vendor.ts`, `std.ts` and `node.ts`
//! answer for it. Their other half belongs to the module graph and the bundler.

const std = @import("std");
const api = @import("gate_api.zig");
const types = @import("gate_types.zig");
const node = @import("node.zig");
const std_ = @import("std.zig");
const node_field = @import("../support/node_field.zig");
const Gate = api.Gate;
const Node = api.Node;
const Symbol = api.Symbol;
const F = api.F;
const eql = api.eql;
const oom = api.oom;

/// `nodeBuiltinId(specifier) !== undefined`.
pub fn isNodeBuiltin(specifier: []const u8) bool {
    return node.builtinId(specifier) != null;
}

/// `module.isBuiltin` also answers for the underscored internals, which have no public id.
const internal_builtins = [_][]const u8{
    "_http_agent",  "_http_client",     "_http_common",        "_http_incoming",   "_http_outgoing",
    "_http_server", "_stream_duplex",   "_stream_passthrough", "_stream_readable", "_stream_transform",
    "_stream_wrap", "_stream_writable", "_tls_common",         "_tls_wrap",
};

fn isBuiltin(specifier: []const u8) bool {
    for (internal_builtins) |id| if (eql(id, specifier)) return true;
    return isNodeBuiltin(specifier);
}

fn hasScheme(s: []const u8) bool {
    if (s.len < 3 or !std.ascii.isAlphabetic(s[0])) return false;
    for (s[1..], 1..) |b, i| {
        if (b == ':') return i >= 2;
        if (!std.ascii.isAlphanumeric(b) and b != '+' and b != '.' and b != '-') return false;
    }
    return false;
}

pub fn isPackageSpecifier(g: *const Gate, specifier: []const u8) bool {
    if (specifier.len == 0 or specifier[0] == '.' or specifier[0] == '/') return false;
    if (hasScheme(specifier)) return false;
    if (specifier.len >= 3 and std.ascii.isAlphabetic(specifier[0]) and specifier[1] == ':' and (specifier[2] == '\\' or specifier[2] == '/')) return false;
    if (isBuiltin(specifier)) return false;
    return classifyStdSpecifier(g, specifier) == null;
}

pub fn classifyStdSpecifier(g: *const Gate, specifier: []const u8) ?std_.Specifier {
    return g.paths.?.std_package.classify(g.a, specifier);
}

pub fn isNodeSourceFile(g: *const Gate, name: []const u8) bool {
    return g.paths.?.node_package.isSourceFile(name);
}

pub fn nodeLocationModule(g: *const Gate) []const u8 {
    return g.paths.?.node_package.locationModule();
}

pub fn commonJsVerdict(g: *const Gate, binding: []const u8) api.Result {
    const why = if (g.mode == .ts)
        "ts mode uses ES modules only"
    else if (g.on_node)
        "under --node only a CommonJS file built through a bundler has it"
    else
        "without --node, Stator uses ES modules only";
    return api.never("STA1110", g.fmt("CommonJS {s} is not supported — {s}", .{ binding, why }));
}

pub fn isFreeGlobal(g: *const Gate, n: *Node, name: []const u8) bool {
    if (!api.identifierIs(n, name)) return false;
    g.c.silent += 1;
    defer g.c.silent -= 1;
    const sym = api.decls.resolveName(g.c, n, name, F.value) orelse return true;
    for (sym.resolve().decls) |d| {
        if (!g.inDeclarationFile(d) and !api.isSourceFile(d) and !api.isIdentifier(d) and d.data != .binary and d.data != .prop_access and d.data != .elem_access and d.data != .call) return false;
    }
    return true;
}

fn isBoundName(parent: *const Node, n: *const Node) bool {
    if (parent.data == .shorthand_assign) return false;
    if (api.declarationName(parent) == n) return true;
    return node_field.of(?*Node, parent, .{ .{ .prop_access, "name" }, .{ .named_tuple_member, "name" }, .{ .jsx_attr, "name" }, .{ .labeled, "label" }, .{ .break_stmt, "label" }, .{ .continue_stmt, "label" } }) == n;
}

pub fn isFreeCommonJsName(g: *const Gate, n: *Node, name: []const u8) bool {
    const parent = n.parent orelse return false;
    if (isBoundName(parent, n)) return false;
    if (parent.data == .qualified_name and parent.data.qualified_name.right == n) return false;
    if (parent.data == .binding_elem and parent.data.binding_elem.prop_name == n) return false;
    return isFreeGlobal(g, n, name);
}

/// The `"type"` of the nearest package.json above `dir`.
fn packageType(g: *const Gate, dir: []const u8) ?[]const u8 {
    var current: ?[]const u8 = dir;
    while (current) |d| : (current = std.fs.path.dirname(d)) {
        const path = std.fs.path.join(g.a, &.{ d, "package.json" }) catch oom();
        const content = std.Io.Dir.cwd().readFileAlloc(g.paths.?.node_package.io, path, g.a, .limited(16 * 1024 * 1024)) catch continue;
        const parsed = std.json.parseFromSliceLeaky(std.json.Value, g.a, content, .{}) catch return null;
        if (parsed != .object) return null;
        const field = parsed.object.get("type") orelse return null;
        return if (field == .string) field.string else null;
    }
    return null;
}

const TopLevelModule = struct {
    found: bool = false,
    top: bool,

    fn visit(s: *TopLevelModule, n: *Node) void {
        if (s.found) return;
        if (n.data == .meta_property and n.data.meta_property.keyword == .kw_import) {
            s.found = true;
            return;
        }
        if (s.top and (n.data == .await_expr or (n.data == .for_of and n.data.for_of.is_await))) {
            s.found = true;
            return;
        }
        const outer = s.top;
        s.top = outer and !api.isFunctionLike(n) and n.data != .static_block;
        api.ast.forEachChild(n, s, visit);
        s.top = outer;
    }
};

fn hasModuleSyntax(root: *Node) bool {
    for (root.data.source_file.stmts) |statement| {
        if (statement.data == .import_decl or statement.data == .export_decl or statement.data == .export_assign or statement.mods.@"export") return true;
    }
    var state = TopLevelModule{ .top = true };
    TopLevelModule.visit(&state, root);
    return state.found;
}

pub fn isSyntaxFreeEsModule(g: *const Gate, target: *Node) bool {
    const file = g.fileOf(target) orelse return false;
    if (!std.mem.endsWith(u8, file.path, ".js")) return false;
    const dir = std.fs.path.dirname(file.path) orelse return false;
    const kind = packageType(g, dir) orelse return false;
    return eql(kind, "module") and !hasModuleSyntax(target);
}

const Target = struct { file: ?*api.File, name: ?[]const u8, namespace: bool };

/// Where an exported name finally lands, so two `export *` of one binding do not read as ambiguous.
fn exportTarget(g: *Gate, symbol: ?*Symbol) ?Target {
    var seen: std.ArrayList(*Symbol) = .empty;
    var current = symbol;
    while (current) |s0| {
        const s = s0.resolve();
        if (std.mem.indexOfScalar(*Symbol, seen.items, s) != null) return null;
        seen.append(g.a, s) catch oom();
        for (s.decls) |d| {
            if (d.data == .export_assign) {
                if (d.data.export_assign.is_equals) return null;
                return .{ .file = g.fileOf(d), .name = types.default_export_binding, .namespace = false };
            }
        }
        if (s.flags & F.alias == 0) return declarationTarget(g, s);
        current = g.aliased(s);
    }
    return null;
}

fn declarationTarget(g: *Gate, s: *Symbol) ?Target {
    const declaration = g.declarationOf(s) orelse (if (s.decls.len > 0) s.decls[0] else return null);
    if (api.isSourceFile(declaration)) return .{ .file = g.fileOf(declaration), .name = null, .namespace = true };
    const file = g.fileOf(declaration) orelse return null;
    if (file.is_dts or s.flags & F.value == 0) return null;
    if (api.isFunctionDeclaration(declaration) or api.isClassDeclaration(declaration)) {
        const name = api.declarationName(declaration);
        if (name) |n| return .{ .file = file, .name = api.text(n), .namespace = false };
        return if (types.isDefaultExportDeclaration(declaration)) .{ .file = file, .name = types.default_export_binding, .namespace = false } else null;
    }
    const name = api.declarationName(declaration) orelse return null;
    return if (api.isIdentifier(name)) .{ .file = file, .name = api.text(name), .namespace = false } else null;
}

pub const NameSet = std.StringHashMapUnmanaged(void);

pub fn ambiguousStarExports(g: *Gate, root: *Node) NameSet {
    var visiting: std.AutoHashMapUnmanaged(*Node, void) = .empty;
    return ambiguousIn(g, root, &visiting);
}

fn ambiguousIn(g: *Gate, root: *Node, visiting: *std.AutoHashMapUnmanaged(*Node, void)) NameSet {
    var ambiguous: NameSet = .empty;
    const file = g.fileOf(root) orelse return ambiguous;
    const module = file.symbol orelse return ambiguous;
    if (visiting.contains(root)) return ambiguous;
    visiting.put(g.a, root, {}) catch oom();
    const own = module.resolve().exports;
    var seen: std.StringHashMapUnmanaged([]const u8) = .empty;
    for (root.data.source_file.stmts) |statement| {
        if (statement.data != .export_decl) continue;
        const x = statement.data.export_decl;
        if (x.clause != null or x.type_only) continue;
        const spec = x.specifier orelse continue;
        const target = g.symbolAt(spec) orelse continue;
        for (api.decls.exportsOf(g.c, target.resolve())) |exported| {
            const name = exported.name;
            if (eql(name, "default") or (own != null and own.?.get(name) != null)) continue;
            const resolved = exportTarget(g, exported);
            const key = if (resolved) |r|
                g.fmt("{s}\x00{s}", .{ if (r.file) |f| f.path else "", if (r.namespace) "*" else r.name orelse "" })
            else
                name;
            if (seen.get(name)) |previous| {
                if (!eql(previous, key)) ambiguous.put(g.a, name, {}) catch oom();
            } else {
                seen.put(g.a, name, key) catch oom();
            }
        }
    }
    for (root.data.source_file.stmts) |statement| {
        if (statement.data != .export_decl) continue;
        const x = statement.data.export_decl;
        if (x.clause != null) continue;
        const spec = x.specifier orelse continue;
        const target = g.declarationOf(g.symbolAt(spec)) orelse continue;
        if (!api.isSourceFile(target)) continue;
        var nested = ambiguousIn(g, target, visiting);
        var it = nested.keyIterator();
        while (it.next()) |name| {
            if (own == null or own.?.get(name.*) == null) ambiguous.put(g.a, name.*, {}) catch oom();
        }
    }
    _ = visiting.remove(root);
    return ambiguous;
}
