//! One `Session` per program, with Stator's own compiler options: the user's tsconfig decides
//! nothing here. The checker's answers become Stator diagnostics in this file and nowhere else.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const fspath = std.fs.path;
const stator_ts = @import("stator_ts");
const ast = stator_ts.ast;
const binder = stator_ts.binder;
const decls = stator_ts.decls;
const pool = stator_ts.pool;
const project = stator_ts.project;
const T = stator_ts.types;
const Session = stator_ts.Session;
const Sym = stator_ts.Sym;
const support = @import("../support/root.zig");
const report = support.diagnostics;
const crash = @import("../cli/crash.zig");
const api = @import("gate_api.zig");
const gate_modules = @import("gate_modules.zig");
const gate_types = @import("gate_types.zig");
const modules = @import("modules.zig");
const node_edge = @import("node.zig");
const std_edge = @import("std.zig");

const Diagnostic = report.Diagnostic;
const Mode = report.Mode;
const Node = ast.Node;
const File = ast.File;
const Printed = stator_ts.session.Printed;
const SourceFile = project.SourceFile;

fn oom() noreturn {
    @panic("out of memory");
}

/// Where the program's fixed inputs live; none of them comes from the user's project.
pub const Paths = struct {
    /// `stator.globals.d.ts`: what `libjsrt.a` provides, in place of Node's globals and the DOM's.
    globals: []const u8,
    lib_dir: []const u8,
    std_package: std_edge.Package,
    node_package: node_edge.Package,
};

pub const Request = struct {
    /// Absolute: a relative root would keep a relative name while resolution answers absolute
    /// ones, and every import edge would silently miss its file.
    entry: []const u8,
    mode: Mode,
    node: bool,
    paths: *const Paths,
    /// Text that replaces a file's bytes: the rewrites a second load is made for.
    overlay: ?*const project.Overlay = null,
    /// A file whose type errors are package code on the dynamic path.
    unchecked: ?[]const u8 = null,
};

/// Keyed by the address `Sym` wraps: a symbol is one object however it is reached.
pub const SymbolSet = std.AutoHashMapUnmanaged(usize, void);

pub fn symbolKey(sym: Sym) usize {
    return switch (sym) {
        .symbol => |x| @intFromPtr(x),
        .prop => |x| @intFromPtr(x),
    };
}

pub const Loaded = struct {
    session: Session,
    entry_file: ?*SourceFile,
    diagnostics: []const Diagnostic,
    /// The subset no bundle could fix: syntax, binder and early errors.
    parse_diagnostics: []const Diagnostic,
    /// Bindings the lowering must treat as dynamic: the checker proved them inconsistent, and
    /// JavaScript, which has an answer for that, runs them anyway.
    runtime_dynamic: SymbolSet,
    /// The same symbols by fully qualified name, the form the lowering matches on.
    runtime_dynamic_names: []const []const u8,
};

const supported_extensions = [_][]const u8{ ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".cts", ".d.cts", ".cjs", ".mts", ".d.mts", ".mjs" };
const supported_list = "'.ts', '.tsx', '.d.ts', '.js', '.jsx', '.cts', '.d.cts', '.cjs', '.mts', '.d.mts', '.mjs'";
const root_reason = "\n  The file is in the program because:\n    Root file specified for compilation";

fn isSupported(path: []const u8) bool {
    for (supported_extensions) |extension| if (std.mem.endsWith(u8, path, extension)) return true;
    return false;
}

const exists = support.package_root.exists;

const Root = struct {
    path: ?[]const u8,
    refusal: ?[]const u8 = null,
};

/// tsc's reading of a root file name: a known extension is taken as written, an unknown one is
/// refused, and none at all tries each known one.
fn entryRoot(a: Allocator, io: Io, entry: []const u8) Root {
    // `moduleResolution: bundler` turns `resolveJsonModule` on, and a JSON file is then a root too.
    if (isSupported(entry) or std.mem.endsWith(u8, entry, ".json")) return .{ .path = entry };
    if (fspath.extension(entry).len > 0) {
        const refusal = std.fmt.allocPrint(a, "File '{s}' has an unsupported extension. The only supported extensions are " ++ supported_list ++ "." ++ root_reason, .{entry}) catch oom();
        return .{ .path = null, .refusal = refusal };
    }
    for (supported_extensions) |extension| {
        const candidate = std.mem.concat(a, u8, &.{ entry, extension }) catch oom();
        if (exists(io, candidate)) return .{ .path = candidate };
    }
    const refusal = std.fmt.allocPrint(a, "Could not resolve the path '{s}' with the extensions: " ++ supported_list ++ "." ++ root_reason, .{entry}) catch oom();
    return .{ .path = null, .refusal = refusal };
}

/// What `createProgram` passes tsc. Options absent here are the ones stator-ts has no use for:
/// `sourceMap` and `noEmit` steer emit. `erasableSyntaxOnly` needs a TS1294 check in stator-ts.
fn compilerOptions(mode: Mode) project.Options {
    const is_ts = mode == .ts;
    return .{
        .strict = true,
        // ts mode's `any` is a refusal; js mode's untyped code is what it is for.
        .noImplicitAny = is_ts,
        // The oracle is tsc 6, and js mode's `let x;` is flow-typed there.
        .jsVariablesFollowFlow = true,
        .noImplicitThis = is_ts,
        .noImplicitOverride = is_ts,
        .noFallthroughCasesInSwitch = is_ts,
        .useUnknownInCatchVariables = is_ts,
        .noUncheckedIndexedAccess = true,
        .exactOptionalPropertyTypes = true,
        .verbatimModuleSyntax = true,
        .allowImportingTsExtensions = true,
        .rewriteRelativeImportExtensions = true,
        .module = "esnext",
        .moduleResolution = "bundler",
        .moduleDetection = "force",
        .target = "es2025",
        .lib = &.{"es2025"},
        .allowJs = true,
        .skipLibCheck = true,
    };
}

fn pathMappings(a: Allocator, request: Request) []const project.PathMapping {
    var list: std.ArrayList(project.PathMapping) = .empty;
    list.append(a, request.paths.std_package.pathMapping(a)) catch oom();
    if (request.node) list.appendSlice(a, request.paths.node_package.pathMappings(a)) catch oom();
    return list.items;
}

/// The gate's own type questions, asked before there is a gate: one rule, so the widening below
/// and the gate cannot disagree.
pub fn questions(a: Allocator, s: Session, request: Request) api.Gate {
    return .{ .a = a, .c = s.c, .mode = request.mode, .on_node = request.node, .paths = request.paths };
}

pub fn load(a: Allocator, io: Io, tp: *pool.ThreadPool, request: Request) Loaded {
    const root = entryRoot(a, io, request.entry);
    var roots: std.ArrayList([]const u8) = .empty;
    roots.append(a, request.paths.globals) catch oom();
    if (request.node) if (request.paths.node_package.globalsFile()) |file| roots.append(a, file) catch oom();
    if (root.path) |path| roots.append(a, path) catch oom();

    const config = a.create(project.Config) catch oom();
    config.* = .{
        .root = fspath.dirname(request.entry) orelse "/",
        .options = compilerOptions(request.mode),
        .files = roots.items,
        .paths = pathMappings(a, request),
        .paths_base = "/",
    };
    const fs = project.FsCache.create(a, io);
    const prog = project.loadProgram(a, io, tp, config, roots.items, .{ .fs = fs, .lib_dir_flag = request.paths.lib_dir, .overlay = request.overlay });
    const c = T.Checker.new(a, prog);
    decls.initGlobals(c);
    const cwd = Io.Dir.cwd().realPathFileAlloc(io, ".", a) catch "";
    const session: Session = .{ .prog = prog, .c = c, .synthetic = .create(a, c), .cwd = cwd };

    var classify: Classify = .{ .a = a, .session = session, .request = request, .gate = questions(a, session, request) };
    if (root.refusal) |message| classify.fileLess(message);
    for (prog.missing_roots.items) |path| classify.fileLess(std.fmt.allocPrint(a, "File '{s}' not found." ++ root_reason, .{path}) catch oom());
    crash.setChecking(true);
    const checked = session.preEmitDiagnostics(a, request.mode == .js);
    crash.setChecking(false);
    for (checked) |d| classify.diagnostic(d);
    classify.earlyImportErrors();

    const entry_file = if (root.path) |path| prog.by_path.get(path) else null;
    return .{
        .session = session,
        .entry_file = entry_file,
        .diagnostics = classify.diagnostics.items,
        .parse_diagnostics = classify.parse.items,
        .runtime_dynamic = classify.runtime_dynamic,
        .runtime_dynamic_names = classify.runtime_dynamic_names.items,
    };
}

fn isOneOf(code: u32, comptime list: []const u32) bool {
    return std.mem.indexOfScalar(u32, list, code) != null;
}

const undeclared_name_codes = [_]u32{ 2304, 2580, 2591, 18004 };
const unresolved_module_codes = [_]u32{ 2307, 2580, 2591 };
const unresolved_name_codes = [_]u32{ 2304, 2580, 2591 };
const missing_member_codes = [_]u32{ 2305, 2724, 2614 };
/// Where the checker sees one of these, Node throws at run time and the compiled program would not.
const vendor_throw_codes = [_]u32{ 2448, 2449, 2450, 2588 };
const both_modes_runtime_codes = [_]u32{2407};
/// Refusals js mode answers with exact run-time semantics. A code enters this list with its answer
/// and a test: an unlisted one reaching the lowering is a miscompile at worst.
const js_mode_runtime_codes = [_]u32{
    1016, 2554, 2556, 2322, 2345,  2769,  2339,  2551, 2353, 2349, 2367, 2362, 2363, 18050, 2403, 2695,
    8024, 8029, 2304, 2552, 2540,  2704,  2790,  2375, 2379, 2412, 2464, 2538, 1117, 2783,  2531, 2532,
    2533, 2721, 2722, 2723, 18047, 18048, 18049, 2454, 2488, 2630, 2698, 2350, 2565, 2308,
};

/// The deepest `extends` chain followed. tsc's checker has refused a cycle by now, but that refusal
/// is an ordinary diagnostic and this walk runs beside it.
const max_base_depth = 256;

/// The innermost node of `kind` whose span holds `position`.
fn innermostAt(file: *File, position: u32, comptime kind: std.meta.Tag(@FieldType(Node, "data"))) ?*Node {
    const Search = struct {
        position: u32,
        found: ?*Node = null,

        fn step(s: *@This(), n: *Node) support.ast_walk.Step {
            if (s.position < n.start or s.position >= n.end) return .skip;
            if (n.data == kind) s.found = n;
            return .descend;
        }
    };
    var search: Search = .{ .position = position };
    _ = support.ast_walk.contains(file.root, &search, Search.step);
    return search.found;
}

fn isNodePathGlobalRead(d: Printed) bool {
    if (!isOneOf(d.code, &undeclared_name_codes)) return false;
    const n = innermostAt(d.file, d.start, .identifier) orelse return false;
    const name = n.data.identifier;
    return std.mem.eql(u8, name, "__filename") or std.mem.eql(u8, name, "__dirname");
}

/// Spec B.3.1: two `__proto__` data properties are an early error, unlike every other duplicate
/// key. A computed key, a shorthand, a method or an accessor is legal, so only `name: value` counts.
fn isDuplicateProtoDataProperty(file: *File, position: u32) bool {
    const literal = innermostAt(file, position, .object_lit) orelse return false;
    var count: u32 = 0;
    for (literal.data.object_lit.props) |property| {
        if (property.data != .property_assign) continue;
        const text = switch (property.data.property_assign.name.data) {
            .identifier, .string_lit => |x| x,
            else => continue,
        };
        if (std.mem.eql(u8, text, "__proto__")) count += 1;
    }
    return count >= 2;
}

fn isCoercingCompound(op: ast.Tok) bool {
    return switch (op) {
        .minus_assign, .star_assign, .slash_assign, .percent_assign, .star2_assign => true,
        else => false,
    };
}

fn stripped(n: *Node) *Node {
    var at = n;
    while (true) at = switch (at.data) {
        .paren => |x| x.expr,
        .non_null => |x| x.expr,
        else => return at,
    };
}

/// `s *= 2` puts a number in `s` whatever it held, so `s` widens. `s * 2` only reads it, and
/// `o.x *= 2` writes a member, which is not a binding.
fn compoundAssignTarget(token: *Node) ?*Node {
    var n = token;
    while (true) {
        const parent = n.parent orelse return null;
        switch (parent.data) {
            .paren, .non_null => n = parent,
            .binary => |x| {
                if (x.left != n or !isCoercingCompound(x.op)) return null;
                const target = stripped(x.left);
                return if (target.data == .identifier) target else null;
            },
            else => return null,
        }
    }
}

/// A return edge spelled without `return`: the identifier is a callee or an operand, and widening
/// it would turn that function dynamic. The span must be the whole body, because `() => x = v`
/// starts at the same identifier and its own error spans only `x`.
fn isConciseReturnAt(token: *Node, length: u32) bool {
    const start = token.start;
    var n = token;
    while (true) {
        const parent = n.parent orelse return false;
        if (parent.data == .source_file or api.isArrowFunction(parent) or parent.start != start) break;
        n = parent;
    }
    n = api.outermostParen(n);
    const parent = n.parent orelse return false;
    if (!api.isArrowFunction(parent) or parent.data.func.body != n) return false;
    return api.skipParens(n).end == start + length;
}

/// Only an unannotated, bodied method: a disagreement over what the user wrote stays a refusal.
fn methodIsUnannotated(file: *const File, member: *const Node) bool {
    const f = member.data.func;
    if (f.body == null or f.ret != null) return false;
    for (f.params) |param| if (param.data.param.type != null) return false;
    return !hasJsDocType(file, member);
}

/// stator-ts keeps no JSDoc nodes, so this reads the `/** */` right before the member. A type is
/// what counts: `@returns {T}` or `@param {T} x`, not a tag with prose after it.
fn hasJsDocType(file: *const File, member: *const Node) bool {
    const before = std.mem.trimEnd(u8, file.src[0..member.start], " \t\r\n");
    if (!std.mem.endsWith(u8, before, "*/")) return false;
    const open = std.mem.lastIndexOf(u8, before, "/**") orelse return false;
    const comment = before[open..];
    for ([_][]const u8{ "@returns", "@return", "@param" }) |tag| {
        var from: usize = 0;
        while (std.mem.indexOfPos(u8, comment, from, tag)) |at| {
            from = at + tag.len;
            const rest = std.mem.trimStart(u8, comment[from..], " \t");
            if (rest.len > 0 and rest[0] == '{') return true;
        }
    }
    return false;
}

fn identifierName(n: ?*Node) ?[]const u8 {
    const name = n orelse return null;
    return if (name.data == .identifier) name.data.identifier else null;
}

const Classify = struct {
    a: Allocator,
    session: Session,
    request: Request,
    gate: api.Gate,
    diagnostics: std.ArrayList(Diagnostic) = .empty,
    parse: std.ArrayList(Diagnostic) = .empty,
    runtime_dynamic: SymbolSet = .empty,
    runtime_dynamic_names: std.ArrayList([]const u8) = .empty,

    fn fileLess(k: *Classify, message: []const u8) void {
        const d = report.fromFile("<unknown>", 1, 1, "STA0012", .@"error", k.request.mode, message, null, null);
        k.diagnostics.append(k.a, d) catch oom();
    }

    fn widen(k: *Classify, sym: Sym) void {
        k.runtime_dynamic.put(k.a, symbolKey(sym), {}) catch oom();
        k.runtime_dynamic_names.append(k.a, k.session.fullyQualifiedName(sym)) catch oom();
    }

    fn valueDeclaration(sym: Sym) ?*Node {
        const own = sym.binderSymbol() orelse return null;
        return own.value_decl;
    }

    fn assignsFunctionDeclaration(k: *const Classify, d: Printed) bool {
        const token = innermostAt(d.file, d.start, .identifier) orelse return false;
        const sym = k.session.symbolAt(token) orelse return false;
        const declaration = valueDeclaration(sym) orelse return false;
        return declaration.data == .func and declaration.data.func.kind == .decl and declaration.data.func.body != null;
    }

    fn findBaseMethod(k: *const Classify, class: *const Node, name: []const u8, depth: u32) ?*Node {
        if (depth == 0) return null;
        for (class.data.class.heritage) |clause| {
            const heritage = clause.data.heritage_clause;
            if (heritage.tok != .kw_extends) continue;
            if (heritage.types.len == 0) return null;
            const base = heritage.types[0].data.expr_with_type_args.expr;
            const sym = k.session.symbolAt(base) orelse return null;
            for (sym.declarations()) |declaration| {
                if (declaration.data != .class) continue;
                for (declaration.data.class.members) |member| {
                    if (member.data != .func or member.data.func.kind != .method) continue;
                    if (std.mem.eql(u8, identifierName(member.data.func.name) orelse continue, name)) return member;
                }
                if (k.findBaseMethod(declaration, name, depth - 1)) |higher| return higher;
            }
            return null;
        }
        return null;
    }

    /// An override js mode may run: both sides bodied methods neither annotated, because only that
    /// shape has a lowering defense. A field shares one slot for two types and no widening helps.
    fn inferredOverride(k: *const Classify, d: Printed) ?struct { derived: Sym, base: Sym } {
        const name = innermostAt(d.file, d.start, .identifier) orelse return null;
        const member = name.parent orelse return null;
        if (member.data != .func or member.data.func.kind != .method) return null;
        const own = identifierName(member.data.func.name) orelse return null;
        if (member.data.func.name != name or !methodIsUnannotated(d.file, member)) return null;
        const class = member.parent orelse return null;
        if (class.data != .class) return null;
        const base = k.findBaseMethod(class, own, max_base_depth) orelse return null;
        const base_file = decls.fileOf(k.session.c, base) orelse return null;
        if (!methodIsUnannotated(base_file, base)) return null;
        const derived_sym = k.session.symbolAt(name) orelse return null;
        const base_sym = k.session.symbolAt(base.data.func.name.?) orelse return null;
        return .{ .derived = derived_sym, .base = base_sym };
    }

    /// A TypeScript file's annotation of a type a tag settles keeps its check at the edge
    /// (STA2001); widening would silently discard what the author claimed.
    fn keepsCheckedAnnotation(k: *Classify, sym: Sym) bool {
        const declaration = valueDeclaration(sym) orelse return false;
        if (declaration.data != .var_decl) return false;
        const annotation = declaration.data.var_decl.type orelse return false;
        const file = decls.fileOf(k.session.c, declaration) orelse return false;
        if (file.is_dts or project.isJsFile(file.path)) return false;
        const t = gate_types.tsTypeToHType(&k.gate, k.session.typeFromTypeNode(annotation));
        return switch (t.*) {
            .number, .string, .boolean => true,
            else => false,
        };
    }

    fn widenFor(k: *Classify, d: Printed) void {
        if (!isOneOf(d.code, &.{ 2322, 2403, 2630, 2362, 2363, 2454 })) return;
        const token = innermostAt(d.file, d.start, .identifier) orelse return;
        const reads_itself = isOneOf(d.code, &.{ 2322, 2403, 2454, 2630 });
        const target = if (reads_itself) token else compoundAssignTarget(token) orelse return;
        if (d.code == 2322 and isConciseReturnAt(target, d.len)) return;
        const sym = k.session.symbolAt(target) orelse return;
        if (d.code == 2322 and k.keepsCheckedAnnotation(sym)) return;
        k.widen(sym);
    }

    /// A refusal the std and Node edges own; the checker's own wording would name a flag or a
    /// `@types` package the user cannot act on.
    fn edgeRefusal(k: *const Classify, d: Printed) ?Edge {
        const file = d.file;
        const literal = file.src[d.start..@min(d.start + d.len, file.src.len)];
        if (isOneOf(d.code, &unresolved_name_codes) and std.mem.eql(u8, literal, "require")) return .gate;
        const paths = k.request.paths;
        if (isOneOf(d.code, &unresolved_module_codes) and literal.len >= 2 and (literal[0] == '"' or literal[0] == '\'')) {
            const specifier = literal[1 .. literal.len - 1];
            if (paths.std_package.classify(k.a, specifier)) |classified| return switch (classified) {
                .module => null,
                .unknown => |message| .{ .refusal = .{ .code = "STA3002", .class = .@"error", .message = message } },
            };
            const refusal = paths.node_package.classifySpecifier(specifier, k.request.node) orelse return null;
            return .{ .refusal = .{ .code = "STA1214", .class = .@"not-yet", .message = refusal.message, .phase = refusal.phase } };
        }
        if (isOneOf(d.code, &missing_member_codes)) {
            const specifier = moduleSpecifierAt(file, d.start) orelse return null;
            const refusal = paths.node_package.classifyMember(specifier, literal, k.request.node) orelse return null;
            return .{ .refusal = .{ .code = "STA1214", .class = .@"not-yet", .message = refusal.message, .phase = refusal.phase } };
        }
        return null;
    }

    fn diagnostic(k: *Classify, d: Printed) void {
        // A free `__filename` is the gate's STA1110 in both modes.
        if (isNodePathGlobalRead(d)) return;
        const is_js = k.request.mode == .js;
        const keep_proto = is_js and d.code == 1117 and isDuplicateProtoDataProperty(d.file, d.start);
        // A named function expression's own name is immutable, so widening would compile a write
        // JavaScript never performs. Only a function declaration's binding is writable.
        const keep_function_name = d.code == 2630 and !k.assignsFunctionDeclaration(d);
        var override_widened = false;
        if (is_js and d.code == 2416) {
            if (k.inferredOverride(d)) |pair| {
                k.widen(pair.derived);
                k.widen(pair.base);
                override_widened = true;
            }
        }
        const runs = override_widened or isOneOf(d.code, &both_modes_runtime_codes) or (is_js and isOneOf(d.code, &js_mode_runtime_codes));
        if (!keep_proto and !keep_function_name and runs) {
            k.widenFor(d);
            return;
        }
        if (k.edgeRefusal(d)) |edge| switch (edge) {
            .gate => return,
            .refusal => |r| {
                const at = report.positionOf(d.file.src, d.start);
                const located = report.fromFile(d.file.path, at.line, at.column, r.code, r.class, k.request.mode, r.message, .{ .start = d.start, .length = d.len }, r.phase);
                k.diagnostics.append(k.a, located) catch oom();
                return;
            },
        };
        if (k.request.unchecked) |unchecked| {
            if (std.mem.eql(u8, d.file.path, unchecked) and d.code >= 2000 and !isOneOf(d.code, &vendor_throw_codes)) {
                const token = innermostAt(d.file, d.start, .identifier) orelse return;
                if (k.session.symbolAt(token)) |sym| k.widen(sym);
                return;
            }
        }
        const at = report.positionOf(d.file.src, d.start);
        const span: report.Span = .{ .start = d.start, .length = if (d.len > 0) d.len else 1 };
        const located = report.fromFile(d.file.path, at.line, at.column, "STA0012", .@"error", k.request.mode, d.msg, span, null);
        k.diagnostics.append(k.a, located) catch oom();
        if (d.syntax or d.bind) k.parse.append(k.a, located) catch oom();
    }

    fn earlyImportErrors(k: *Classify) void {
        for (k.session.prog.files.items) |sf| {
            if (sf.file.is_dts) continue;
            for (modules.strictReservedImports(k.a, sf.file.root)) |name| {
                const text = name.data.identifier;
                const message = std.fmt.allocPrint(k.a, "'{s}' cannot be an imported binding: a module is strict code", .{text}) catch oom();
                const at = report.positionOf(sf.file.src, name.start);
                const span: report.Span = .{ .start = name.start, .length = @intCast(text.len) };
                const early = report.fromFile(sf.file.path, at.line, at.column, "STA3005", .@"error", k.request.mode, message, span, null);
                k.diagnostics.append(k.a, early) catch oom();
                k.parse.append(k.a, early) catch oom();
            }
        }
    }
};

const Edge = union(enum) {
    gate,
    refusal: struct {
        code: []const u8,
        class: report.Class,
        message: []const u8,
        phase: ?u32 = null,
    },
};

/// The top-level import or re-export holding `position`.
fn moduleSpecifierAt(file: *const File, position: u32) ?[]const u8 {
    for (file.root.data.source_file.stmts) |statement| {
        if (position < statement.start or position >= statement.end) continue;
        const specifier: ?*Node = switch (statement.data) {
            .import_decl => |x| x.specifier,
            .export_decl => |x| x.specifier,
            else => null,
        };
        const n = specifier orelse return null;
        return if (n.data == .string_lit) n.data.string_lit else null;
    }
    return null;
}

test "tsc's root rules" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expectEqualStrings("/x/a.ts", entryRoot(a, std.testing.io, "/x/a.ts").path.?);
    try std.testing.expect(entryRoot(a, std.testing.io, "/x/a.txt").path == null);
    try std.testing.expect(std.mem.startsWith(u8, entryRoot(a, std.testing.io, "/x/a").refusal.?, "Could not resolve the path"));
}
