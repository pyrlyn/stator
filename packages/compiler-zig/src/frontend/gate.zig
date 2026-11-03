//! The mode policy gate: walks each source file and answers accept, never or not-yet per construct.
//! Everything below this pass may assume what it accepted; nothing below it knows the mode.

const std = @import("std");
const api = @import("gate_api.zig");
const types = @import("gate_types.zig");
const call_ = @import("gate_call.zig");
const class_ = @import("gate_class.zig");
const extern_ = @import("gate_extern.zig");
const fn_ = @import("gate_function.zig");
const generics = @import("gate_generics.zig");
const globals = @import("gate_globals.zig");
const literal = @import("gate_literal.zig");
const member = @import("gate_member.zig");
const modules = @import("gate_modules.zig");
const ops = @import("gate_ops.zig");
const N = @import("../hir/nodes.zig");
const support = @import("../support/root.zig");

const F = api.F;
const Gate = api.Gate;
const Node = api.Node;
const Result = api.Result;
const Symbol = api.Symbol;
const Type = api.Type;
const accept = api.accept;
const eql = api.eql;
const oom = api.oom;

pub const Api = api;

pub const generatorNotYet = fn_.generatorNotYet;
pub const isVarDeclarationList = member.isVarDeclarationList;

/// One verdict per construct, for tools that want more than the diagnostics.
pub const Trace = struct {
    context: *anyopaque,
    visit: *const fn (context: *anyopaque, node: *Node, result: Result) void,
};

const report = support.diagnostics;

fn diagnosticAt(g: *Gate, n: *Node, code: []const u8, class: report.Class, message: []const u8, phase: ?u32) void {
    const file = g.fileOf(n) orelse return;
    const d = report.fromRange(file.path, file.src, n.start, n.end, code, class, g.mode, message, phase);
    g.diagnostics.append(g.a, d) catch oom();
}

fn className(_: void, n: *Node) ?*Node {
    return if (api.isClassLike(n)) n.data.class.name else null;
}

fn isLibrary(source: *const api.project.SourceFile, file: *const api.File) bool {
    return file.is_dts or source.is_lib;
}

fn countClassNames(g: *Gate, prog: *const api.project.Program) void {
    for (prog.files.items) |source| {
        const file = source.file;
        if (isLibrary(source, file)) continue;
        if (g.mode == .ts and std.mem.endsWith(u8, file.path, ".js")) continue;
        for (support.ast_walk.collect(*Node, g.a, file.root, {}, className) catch oom()) |name| {
            const entry = g.class_names.getOrPutValue(g.a, api.text(name) orelse "", .empty) catch oom();
            entry.value_ptr.append(g.a, file) catch oom();
        }
    }
}

/// `prog` is stator-ts's loaded program. Diagnostics land on `g.diagnostics`, in program order.
/// tsc's binder treats `a.b = v` at the top level of a JS file as declaring `a` there when the file
/// does not (`jsGlobalAugmentations`), so `a` stops reading as a library global everywhere.
fn collectJsGlobals(g: *Gate, prog: *const api.project.Program) void {
    for (prog.files.items) |source| {
        const file = source.file;
        if (file.is_dts or !api.ast.isJsFile(file.path)) continue;
        const locals = file.root.locals();
        for (file.root.data.source_file.stmts) |statement| {
            if (statement.data != .expr_stmt) continue;
            const assignment = statement.data.expr_stmt.expr;
            if (assignment.data != .binary or assignment.data.binary.op != .assign) continue;
            var cursor = assignment.data.binary.left;
            if (cursor.data != .prop_access) continue;
            while (cursor.data == .prop_access) cursor = cursor.data.prop_access.expr;
            if (cursor.data != .identifier or api.identifierIs(cursor, "exports") or api.identifierIs(cursor, "module")) continue;
            if (locals != null and locals.?.get(cursor.data.identifier) != null) continue;
            g.js_globals.put(g.a, cursor.data.identifier, {}) catch oom();
        }
    }
}

pub fn gateProgram(g: *Gate, prog: *const api.project.Program) void {
    collectJsGlobals(g, prog);
    countClassNames(g, prog);
    for (prog.files.items) |source| {
        const file = source.file;
        if (isLibrary(source, file)) {
            extern_.gateExternDeclarations(g, file);
            continue;
        }
        if (g.mode == .ts and std.mem.endsWith(u8, file.path, ".js")) {
            const d = report.fromFile(file.path, 1, 1, "STA1002", .never, g.mode, ".js files are not allowed in ts mode; use `--mode=js` or convert to .ts", null, null);
            g.diagnostics.append(g.a, d) catch oom();
            continue;
        }
        visitNode(g, file.root);
    }
}

fn visitChild(g: *Gate, child: *Node) void {
    visitNode(g, child);
}

fn visitChildren(g: *Gate, node: *Node) void {
    api.ast.forEachChild(node, g, visitChild);
}

pub fn visitNode(g: *Gate, node: *Node) void {
    if (g.mode == .ts and types.hasExplicitAny(node)) {
        diagnosticAt(g, node, "STA1001", .never, "explicit 'any' is not allowed in ts mode; use 'unknown' instead", null);
    }
    if (g.mode == .ts and types.isImplicitAny(g, node)) {
        diagnosticAt(g, node, "STA1003", .never, "implicit 'any' is not allowed in ts mode; add a type annotation", null);
    }
    if (node.data == .qualified_name) return;
    if (api.isTypeNode(node)) {
        visitChildren(g, node);
        return;
    }
    const result = gateConstruct(g, node);
    if (g.trace) |trace| trace.visit(trace.context, node, result);
    switch (result) {
        .accept => visitChildren(g, node),
        .not_yet => |r| diagnosticAt(g, node, r.code, .@"not-yet", r.message, r.phase),
        .never => |r| diagnosticAt(g, node, r.code, .never, r.message, null),
    }
}

fn isToken(node: *const Node) bool {
    return api.isToken(node) and node.data != .identifier and node.data != .this_expr and node.data != .super_expr;
}

pub fn gateConstruct(g: *Gate, node: *Node) Result {
    if (isBigIntUse(g, node)) return api.notYetCode("STA1213", "BigInt is not yet supported; planned for Phase 5", 5);
    if (isToken(node)) return accept;
    if (gateModuleSyntax(g, node)) |result| return result;
    if (globals.isBuiltinValueOrPart(g, node)) return accept;
    switch (node.data) {
        .source_file, .var_stmt, .expr_stmt, .block, .lazy_body, .if_stmt, .while_stmt, .do_stmt, .for_stmt, .switch_stmt, .case_clause, .default_clause => return accept,
        .break_stmt, .continue_stmt, .throw_stmt, .try_stmt => return accept,
        .catch_clause => |x| {
            const binding = x.decl orelse return accept;
            return if (isSimpleBindingPattern(g, binding.data.var_decl.name)) accept else g.notYet("destructuring a caught value is not yet supported", 5);
        },
        .func => {
            const kind = node.data.func.kind;
            return switch (kind) {
                .decl, .expr, .arrow => fn_.gateFunction(g, node),
                .method, .ctor, .getter, .setter, .getter_sig, .setter_sig => accept,
                else => notYetKind(g, node),
            };
        },
        .object_pattern, .array_pattern, .binding_elem, .omitted_expr => return accept,
        .param => return fn_.gateParameter(g, node),
        .type_param => return fn_.gateTypeParameter(g, node),
        .interface, .type_alias => return accept,
        .return_stmt => |x| {
            const returned = x.expr orelse return accept;
            if (types.outSlotInner(g, g.typeAt(returned)) != null) {
                return api.never("STA1125", "returning an out-slot is outside the out-slot contract (docs/FFI.md)");
            }
            return if (class_.enclosingFunctionIsConstructor(node)) g.notYet("a constructor that returns a value is not yet supported", 5) else accept;
        },
        .labeled, .empty_stmt, .paren => return accept,
        .identifier => return gateIdentifier(g, node),
        .var_list => return gateDeclarationList(g, node),
        .var_decl => return gateDeclaration(g, node),
        .binary => return ops.gateBinary(g, node),
        .prefix => return ops.gatePrefixUnary(g, node),
        .postfix => return ops.gateUpdate(g, node),
        .typeof_expr, .as_expr, .satisfies_expr => return accept,
        .delete_expr => return ops.gateDelete(g, node),
        .call => return call_.gateCall(g, node),
        .super_expr => {
            const parent = node.parent orelse return accept;
            if (parent.data == .call and parent.data.call.callee == node) return accept;
            if (parent.data == .prop_access and parent.data.prop_access.expr == node) return accept;
            return g.notYet("super as a value is not yet supported", 5);
        },
        .heritage_clause, .expr_with_type_args, .template_expr, .template_span => return accept,
        .prop_access => {
            if (dynamicCodeGeneration(g, node)) |dynamic| {
                return if (dynamic == .eval) evalResult(g) else functionCtorResult(g);
            }
            if (globals.isConsoleLog(node) or member.isStringLength(g, node) or member.isArrayLength(g, node) or member.isFunctionLength(g, node)) return accept;
            return member.gateMemberAccess(g, node);
        },
        .array_lit => return literal.gateArrayLiteral(g, node),
        .elem_access => return member.gateElementAccess(g, node),
        .for_of => return member.gateForOf(g, node),
        .class => return class_.gateClass(g, node),
        .object_lit => return literal.gateObjectLiteral(g, node),
        .property_assign, .shorthand_assign, .spread_assign, .spread_elem, .property_sig, .index_sig => return accept,
        .property_decl, .static_block => return accept,
        .new_expr => return call_.gateNew(g, node),
        .this_expr => return member.gateThis(g, node),
        .with_stmt => return api.never("STA1109", "with statements are not allowed — ESM is always strict mode"),
        .await_expr => return fn_.gateAwait(g, node),
        .yield_expr => return fn_.gateYield(g, node),
        .computed_name => {
            if (literal.isObjectLiteralComputedKey(node)) return accept;
            if (literal.isClassMemberComputedKey(node) and types.computedKeyStaticName(g, node) != null) return accept;
            const parent = node.parent;
            if (parent != null and parent.?.data == .binding_elem and parent.?.data.binding_elem.prop_name == node and types.computedKeyStaticName(g, node) != null) return accept;
            return if (types.isGlobalSymbolIteratorName(g, node)) accept else g.notYet("a computed property name is not yet supported", 5);
        },
        .conditional, .void_expr, .for_in => return accept,
        else => return notYetKind(g, node),
    }
}

fn notYetKind(g: *const Gate, node: *const Node) Result {
    return g.notYet(g.fmt("this construct ({s}) is not yet supported", .{syntaxKindName(node)}), 5);
}

/// The spelling of TypeScript's `SyntaxKind` for the constructs that reach the refusal.
fn syntaxKindName(node: *const Node) []const u8 {
    return switch (node.data) {
        .decorator => "Decorator",
        .debugger_stmt => "DebuggerStatement",
        .enum_decl => "EnumDeclaration",
        .enum_member => "EnumMember",
        .module_decl => "ModuleDeclaration",
        .module_block => "ModuleBlock",
        .meta_property => "MetaProperty",
        .tagged_template => "TaggedTemplateExpression",
        .non_null => "NonNullExpression",
        .type_assertion => "TypeAssertionExpression",
        .import_equals => "ImportEqualsDeclaration",
        .external_module_ref => "ExternalModuleReference",
        .namespace_export_decl => "NamespaceExportDeclaration",
        .semicolon_member => "SemicolonClassElement",
        .func => switch (node.data.func.kind) {
            .method_sig => "MethodSignature",
            .call_sig => "CallSignature",
            .construct_sig => "ConstructSignature",
            else => "FunctionType",
        },
        .jsx_element => "JsxElement",
        .jsx_self_closing => "JsxSelfClosingElement",
        .jsx_fragment => "JsxFragment",
        .jsx_opening => "JsxOpeningElement",
        .jsx_closing => "JsxClosingElement",
        .jsx_attr => "JsxAttribute",
        .jsx_spread_attr => "JsxSpreadAttribute",
        .jsx_expr => "JsxExpression",
        .jsx_text => "JsxText",
        else => @tagName(node.data),
    };
}

fn gateModuleSyntax(g: *Gate, node: *Node) ?Result {
    switch (node.data) {
        .import_clause, .named_imports, .named_exports, .namespace_import, .namespace_export => return accept,
        .import_decl => return gateImport(g, node),
        .import_spec, .export_spec => return gateSpecifier(g, node),
        .export_decl => |x| {
            const spec = x.specifier orelse return accept;
            return if (x.type_only) accept else gateModuleSpecifier(g, spec);
        },
        .export_assign => |x| return if (x.is_equals) g.notYet("export = is not yet supported", 5) else accept,
        else => return null,
    }
}

pub fn gateImportCall(g: *Gate, call: *Node) Result {
    const args = api.nodes(call.data.call.args);
    if (args.len != 1) {
        return api.notYetCode("STA1207", "dynamic import() is not yet supported; planned for Phase 5 (module namespace objects)", 5);
    }
    const spec = args[0];
    if (spec.data != .string_lit) {
        return api.notYetCode("STA1207", "import() with a computed specifier is not yet supported; planned for Phase 8 (runtime module resolution)", 8);
    }
    if (modules.isPackageSpecifier(g, api.text(spec) orelse "")) {
        return api.notYetCode("STA1214", "import() of a package is not yet supported; planned for Phase 12 (Rolldown's __exportAll)", 12);
    }
    return accept;
}

fn gateSpecifier(g: *Gate, spec: *Node) Result {
    const prop_name, const local = switch (spec.data) {
        .import_spec => |x| .{ x.prop_name, x.name },
        .export_spec => |x| .{ x.prop_name, x.name },
        else => unreachable,
    };
    const module_specifier: ?*Node = blk: {
        var cursor = spec.parent;
        while (cursor) |n| : (cursor = n.parent) {
            if (n.data == .import_decl) break :blk n.data.import_decl.specifier;
            if (n.data == .export_decl) break :blk n.data.export_decl.specifier;
        }
        break :blk null;
    };
    const specifier = module_specifier orelse return accept;
    const target = g.declarationOf(g.symbolAt(specifier)) orelse return accept;
    if (!api.isSourceFile(target)) return accept;
    const name = api.text(prop_name orelse local) orelse "";
    if (eql(name, "default")) return missingDefault(g, target) orelse accept;
    const ambiguous = modules.ambiguousStarExports(g, target);
    if (ambiguous.contains(name)) {
        const path = if (g.fileOf(target)) |f| f.path else "";
        return api.never("STA3003", g.fmt("'{s}' is ambiguous in {s}: two `export *` re-exports bind it differently, so it cannot be imported by name", .{ name, path }));
    }
    return accept;
}

fn missingDefault(g: *Gate, target: *Node) ?Result {
    if (!modules.isSyntaxFreeEsModule(g, target)) return null;
    const path = if (g.fileOf(target)) |f| f.path else "";
    return api.never("STA3004", g.fmt("{s} has no default export: it is an ES module (\"type\": \"module\") with no export statement", .{path}));
}

pub fn isNamespaceMember(g: *Gate, node: *Node) bool {
    return types.namespaceModule(g, g.typeAt(node.data.prop_access.expr)) != null;
}

fn gateImport(g: *Gate, node: *Node) Result {
    const x = node.data.import_decl;
    const clause = if (x.clause) |c| &c.data.import_clause else null;
    if (clause != null and clause.?.type_only) return accept;
    const specifier = gateModuleSpecifier(g, x.specifier);
    if (specifier != .accept) return specifier;
    const target = g.declarationOf(g.symbolAt(x.specifier));
    const module_target = if (target != null and api.isSourceFile(target.?)) target else null;
    if (clause != null and clause.?.name != null and module_target != null) {
        if (missingDefault(g, module_target.?)) |missing| return missing;
    }
    if (clause != null and clause.?.bindings != null and clause.?.bindings.?.data == .namespace_import and module_target != null) {
        const file = g.fileOf(module_target.?);
        if (file != null and file.?.is_dts) return g.notYet("a namespace import of a declaration file is not yet supported", 5);
    }
    return accept;
}

fn hasScriptExtension(text: []const u8) bool {
    const dot = std.mem.lastIndexOfScalar(u8, text, '.') orelse return false;
    const extension = text[dot + 1 ..];
    if (extension.len == 2) return (extension[0] == 't' or extension[0] == 'j') and extension[1] == 's';
    if (extension.len != 3 or (extension[0] != 'c' and extension[0] != 'm')) return false;
    return (extension[1] == 't' or extension[1] == 'j') and extension[2] == 's';
}

fn gateModuleSpecifier(g: *Gate, spec: *Node) Result {
    if (spec.data != .string_lit) return accept;
    const text = api.text(spec) orelse return accept;
    const std_spec = modules.classifyStdSpecifier(g, text);
    if (std_spec) |classified| {
        if (classified == .unknown and g.symbolAt(spec) != null) return api.never("STA3002", classified.unknown);
    }
    if (modules.isNodeBuiltin(text)) {
        const target = g.declarationOf(g.symbolAt(spec));
        if (target == null) return accept;
        if (api.isSourceFile(target.?)) {
            const file = g.fileOf(target.?);
            if (file != null and modules.isNodeSourceFile(g, file.?.path)) return accept;
        }
    }
    if (eql(text, modules.nodeLocationModule(g))) return accept;
    if (std_spec == null and !std.mem.startsWith(u8, text, "./") and !std.mem.startsWith(u8, text, "../")) {
        return api.notYetCode("STA1214", "importing a package is not yet supported here (a package reaches a program only through the js-mode bundler, which takes import declarations, re-exports and one package's `export *`; docs/BUNDLER.md)", null);
    }
    if (std_spec == null and !hasScriptExtension(text)) {
        return api.never("STA1113", "a relative import must name the file's extension (./x.ts, ./x.js) — Node ESM does not resolve extensionless specifiers");
    }
    return accept;
}

fn commonJsBinding(g: *Gate, node: *Node) ?[]const u8 {
    if (modules.isFreeCommonJsName(g, node, "__filename")) return "__filename";
    if (modules.isFreeCommonJsName(g, node, "__dirname")) return "__dirname";
    if (modules.isFreeCommonJsName(g, node, "require")) return "require()";
    const parent = node.parent orelse return null;
    if (parent.data == .typeof_expr) return null;
    if (modules.isFreeCommonJsName(g, node, "exports")) return "exports";
    const is_exports = switch (parent.data) {
        .prop_access => |x| x.expr == node and api.identifierIs(x.name, "exports"),
        .elem_access => |x| x.expr == node and api.isStringLiteralLike(x.index) and eql(api.text(x.index) orelse "", "exports"),
        else => false,
    };
    return if (is_exports and modules.isFreeCommonJsName(g, node, "module")) "module.exports" else null;
}

fn refuseGenericValue(g: *const Gate) Result {
    return g.notYet("using a generic function as a value is not yet supported: no call site determines its type tuple, so no monomorphic specialization can be chosen", 5);
}

fn isBigIntUse(g: *Gate, node: *Node) bool {
    if (node.data == .bigint_lit) return true;
    if (!api.isExpression(node) or api.nameOfParent(node) == node) return false;
    const t: *Type = switch (node.data) {
        .identifier => if (g.symbolAt(node)) |symbol| g.typeOfSymbol(symbol) else g.typeAt(node),
        .prop_access => |x| if (g.property(g.typeAt(x.expr), api.text(x.name) orelse "")) |p| g.propType(p) else g.typeAt(node),
        else => g.typeAt(node),
    };
    for (api.parts(g, t)) |part| if (api.isBigIntLike(part)) return true;
    return false;
}

pub fn symbolNotYet(_: *const Gate) Result {
    return api.notYetCode("STA1212", "Symbol is not yet supported; planned for Phase 5", 5);
}

fn isSymbolIteratorComputedBase(g: *Gate, node: *Node) bool {
    const parent = node.parent orelse return false;
    if (parent.data != .prop_access or parent.data.prop_access.expr != node) return false;
    const grand = parent.parent orelse return false;
    return grand.data == .computed_name and types.isGlobalSymbolIteratorName(g, grand);
}

fn jsDynamicCode() Result {
    return api.notYetCode("STA1206", "eval() and new Function() are not yet supported in js mode; planned for Phase 8 (dynamic tier)", 8);
}

pub fn evalResult(g: *const Gate) Result {
    return if (g.mode == .ts)
        api.never("STA1101", "eval() is not allowed in ts mode — it prevents static analysis and is a permanent design choice")
    else
        jsDynamicCode();
}

pub fn functionCtorResult(g: *const Gate) Result {
    return if (g.mode == .ts)
        api.never("STA1103", "new Function() is not allowed in ts mode — code generation is not supported")
    else
        jsDynamicCode();
}

pub const DynamicCode = enum { eval, function };

pub fn dynamicCodeGeneration(g: *Gate, expression: *Node) ?DynamicCode {
    if (globals.isGlobalNamed(g, expression, "eval")) return .eval;
    if (globals.isGlobalNamed(g, expression, "Function")) return .function;
    if (expression.data == .prop_access and api.identifierIs(expression.data.prop_access.expr, "globalThis")) {
        const name = expression.data.prop_access.name;
        if (api.identifierIs(name, "eval")) return .eval;
        if (api.identifierIs(name, "Function")) return .function;
    }
    return null;
}

pub fn dateNotYet(g: *const Gate, message: []const u8, phase: ?u32) Result {
    if (phase) |p| return api.notYetCode("STA1210", g.fmt("{s} is not yet supported; planned for Phase {d}", .{ message, p }), p);
    return api.notYetCode("STA1210", g.fmt("{s} needs the ICU feature build: rebuild with `just runtime-intl` and compile with STATOR_RUNTIME=intl", .{message}), null);
}

fn aliasedDeclaration(g: *Gate, symbol: ?*Symbol) ?*Node {
    const s = symbol orelse return null;
    if (!api.isAlias(s)) return api.valueDeclaration(s);
    return api.valueDeclaration(g.aliased(s));
}

pub fn classConstructorTypeOf(g: *Gate, t: *Type) bool {
    for (api.parts(g, t)) |constituent| {
        const signatures = g.constructSignatures(constituent);
        if (signatures.len != 1) return false;
        const like = types.classLikeOf(g.returnType(signatures[0])) orelse return false;
        if (types.classDisplayName(like) == null) return false;
    }
    return true;
}

fn isModuleClauseName(node: *const Node) bool {
    const parent = node.parent orelse return false;
    return support.node_field.isAny(parent, .{ .import_spec, .export_spec, .import_clause, .namespace_import, .namespace_export });
}

fn exemptFromGenericValue(node: *const Node, bound_name: ?*const Node) bool {
    if (bound_name == node) return true;
    const parent = node.parent orelse return false;
    return parent.data == .import_spec or (parent.data == .call and parent.data.call.callee == node);
}

fn isCalleeOf(parent: *const Node, node: *const Node) bool {
    return support.node_field.of(*Node, parent, .{.{ .call, "callee" }}) == node;
}

fn isInstanceofRightOf(parent: *const Node, node: *const Node) bool {
    return parent.data == .binary and parent.data.binary.op == .kw_instanceof and parent.data.binary.right == node;
}

fn isTypeofOf(parent: *const Node, node: *const Node) bool {
    return support.node_field.of(*Node, parent, .{.{ .typeof_expr, "expr" }}) == node;
}

fn isSingleConstInitializer(node: *const Node, parent: *const Node) bool {
    return parent.data == .var_decl and parent.data.var_decl.init == node and types.isSingleConstDeclarator(parent);
}

fn gateGenericIdentifier(g: *Gate, node: *Node, parent: *Node, symbol: ?*Symbol, decl: ?*Node) ?Result {
    const alias_target = generics.genericAliasTarget(g, node) != null;
    if (alias_target and isSingleConstInitializer(node, parent)) return accept;
    if (parent.data == .call and parent.data.call.callee != node and alias_target) return accept;
    if (isTypeofOf(parent, node) and generics.genericValueInstantiation(g, node)) return accept;
    const aliased = if (symbol != null and api.isAlias(symbol.?)) aliasedDeclaration(g, symbol) else decl;
    if (aliased) |target| {
        if (api.isFunctionDeclaration(target) and target.data.func.type_params.items.len > 0 and !exemptFromGenericValue(node, api.declarationName(target))) {
            return refuseGenericValue(g);
        }
        if (target.data == .var_decl) {
            const x = target.data.var_decl;
            if (x.init) |initializer| {
                if (api.isFunctionLike(initializer) and generics.genericArrowKey(g, initializer) != null and !exemptFromGenericValue(node, x.name)) return refuseGenericValue(g);
            }
        }
    }
    if (decl) |d| {
        if (d.data == .var_decl and !exemptFromGenericValue(node, d.data.var_decl.name) and alias_target) return refuseGenericValue(g);
    }
    return null;
}

const instanceof_builtins = [_][]const u8{
    "Array",   "Object",     "Function",    "Date",  "Map",       "WeakMap",    "Set",            "WeakSet",     "RegExp",
    "Promise", "Uint8Array", "ArrayBuffer", "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "Boolean",
    "Number",  "String",
};

pub fn isInstanceofBuiltin(name: []const u8) bool {
    for (instanceof_builtins) |b| if (eql(b, name)) return true;
    return false;
}

fn gateGlobalIdentifier(g: *Gate, node: *Node, parent: *Node, name: []const u8) Result {
    if (eql(name, "eval")) return evalResult(g);
    if (eql(name, "Function")) return functionCtorResult(g);
    if (isInstanceofRightOf(parent, node) and isInstanceofBuiltin(name)) return accept;
    if (eql(name, "Symbol")) {
        if (isSymbolIteratorComputedBase(g, node)) return accept;
        if (parent.data == .prop_access and parent.data.prop_access.expr == node) {
            const use = parent.parent;
            if (use != null and use.?.data == .elem_access and use.?.data.elem_access.index == parent and
                types.isSymbolIteratorKey(g, parent) and call_.acceptsSymbolKeyBase(g, use.?.data.elem_access.expr)) return accept;
        }
        return symbolNotYet(g);
    }
    if (isCalleeOf(parent, node) and globals.globalFunctionOf(g, node) != null) return accept;
    if (parent.data == .typeof_expr and globals.globalTypeofOf(g, node)) return accept;
    return g.notYet(g.fmt("the global '{s}' is not yet supported", .{name}), 5);
}

fn gateIdentifier(g: *Gate, node: *Node) Result {
    if (isModuleClauseName(node)) return accept;
    if (commonJsBinding(g, node)) |binding| return modules.commonJsVerdict(g, binding);
    const parent = node.parent orelse return accept;
    const name = node.data.identifier;
    const symbol = g.symbolAt(node);
    const decl = api.valueDeclaration(symbol);
    if (decl != null and api.isClassDeclaration(decl.?) and api.declarationName(decl.?) != node and
        !api.isTypeNode(parent) and !namesAClassInPlace(g, node) and !isSingleConstInitializer(node, parent))
    {
        return g.notYet("using a class as a value is not yet supported", 5);
    }
    if (types.isClassAliasUse(g, node)) {
        return if (isClassAliasNonValueUse(node) or isSingleConstInitializer(node, parent) or isClassAliasUseInPlace(g, node))
            accept
        else
            g.notYet("using a class as a value is not yet supported", 5);
    }
    if (api.isClassExpression(parent) and parent.data.class.name == node) return accept;
    if ((types.classExpressionTarget(g, node) orelse types.innerClassExpression(g, node)) != null) {
        return if (parent.data == .import_spec or parent.data == .export_spec or namesAClassInPlace(g, node))
            accept
        else
            g.notYet("using a class as a value is not yet supported", 5);
    }
    if (eql(name, "outSlot") and !extern_.isOutSlotCallee(g, node)) {
        if (decl) |d| {
            if (api.isFunctionDeclaration(d) and d.data.func.body == null) {
                const function_name = d.data.func.name;
                if (function_name != null and api.identifierIs(function_name.?, "outSlot")) {
                    return api.never("STA1125", "outSlot has no value to alias — only direct outSlot<T>() calls construct slots (docs/FFI.md)");
                }
            }
        }
    }
    if (gateGenericIdentifier(g, node, parent, symbol, decl)) |result| return result;
    if (extern_.externDeclarationOfSymbol(g, symbol) != null and parent.data != .import_spec) {
        return if (extern_.isDirectCalleePosition(node))
            accept
        else
            api.notYetCode("STA1217", "using an extern function as a value is not yet supported (v0 has no C value representation for externs; docs/FFI.md section 6)", null);
    }
    if (eql(name, "outSlot") and extern_.isOutSlotCallee(g, node)) return accept;
    if (isArgumentsObject(node, symbol)) {
        if (isGlobalReference(node)) return gateGlobalIdentifier(g, node, parent, name);
    } else if (symbol != null and !eql(name, "undefined") and !eql(name, "NaN") and !eql(name, "Infinity") and
        // The binder gives an object literal's method a symbol with no declarations; tsc gives it the method.
        api.declarationName(parent) != node and
        isGlobalReference(node) and g.allDeclaredInDeclarationFiles(symbol.?))
    {
        return gateGlobalIdentifier(g, node, parent, name);
    }
    const declaration = decl orelse return accept;
    if (enclosingFunction(declaration) == enclosingFunction(node)) return accept;
    if (mayRunInOwnInitializer(node, declaration)) {
        return api.notYetCode("STA1214", g.fmt("reading '{s}' from a function that may run during its own initializer is not yet supported (no run-time TDZ check)", .{name}), null);
    }
    return accept;
}

/// tsc answers `arguments` in a non-arrow function with a symbol that has no declarations, which
/// reads as a global; stator-ts answers with none, so the scope walk is made here.
fn isArgumentsObject(node: *const Node, symbol: ?*Symbol) bool {
    if (symbol != null or !api.identifierIs(node, "arguments")) return false;
    var cursor = node.parent;
    while (cursor) |n| : (cursor = n.parent) {
        if (api.isFunctionLike(n) and !api.isArrowFunction(n)) return true;
    }
    return false;
}

fn isClassAliasNonValueUse(node: *const Node) bool {
    const parent = node.parent orelse return false;
    if (api.isTypeNode(parent)) return true;
    if (parent.data == .expr_with_type_args and parent.data.expr_with_type_args.expr == node) return true;
    return parent.data == .import_spec or parent.data == .export_spec;
}

fn isClassAliasUseInPlace(g: *Gate, node: *Node) bool {
    const parent = node.parent orelse return false;
    if (parent.data == .new_expr and parent.data.new_expr.callee == node) return true;
    if (isTypeofOf(parent, node) or isInstanceofRightOf(parent, node)) return true;
    return parent.data == .prop_access and parent.data.prop_access.expr == node and
        (api.identifierIs(parent.data.prop_access.name, "name") or types.staticMemberOf(g, parent, null) != null);
}

fn namesAClassInPlace(g: *Gate, node: *Node) bool {
    const parent = node.parent orelse return false;
    switch (parent.data) {
        .new_expr => |x| return x.callee == node,
        .expr_with_type_args => |x| return x.expr == node,
        .prop_access => |x| {
            if (x.name == node) {
                const grand = parent.parent;
                if (grand != null and grand.?.data == .expr_with_type_args and grand.?.data.expr_with_type_args.expr == parent) return true;
            }
            if (x.expr == node) return api.identifierIs(x.name, "name") or types.staticMemberOf(g, parent, null) != null;
            return false;
        },
        else => return isTypeofOf(parent, node) or isInstanceofRightOf(parent, node),
    }
}

fn isGlobalReference(node: *const Node) bool {
    const parent = node.parent orelse return true;
    if (api.isTypeNode(parent)) return false;
    switch (parent.data) {
        .binding_elem => |x| return x.prop_name != node,
        .new_expr => |x| return x.callee != node,
        .binary => |x| return !(x.op == .kw_instanceof and x.right == node),
        .prop_access => |x| {
            if (x.name == node) return false;
            if (x.expr != node) return true;
            if (globals.isConsoleLog(parent)) return false;
            const exempt = [_][]const u8{ "Array", "Number", "Date", "Uint8Array", "ArrayBuffer", "Math", "Object", "Promise", "String", "JSON" };
            for (exempt) |name| if (api.identifierIs(node, name)) return false;
            return true;
        },
        else => return true,
    }
}

fn enclosingFunction(node: *const Node) ?*const Node {
    var cursor = node.parent;
    while (cursor) |n| : (cursor = n.parent) {
        if (api.isFunctionLike(n)) return n;
    }
    return null;
}

fn mayRunInOwnInitializer(node: *const Node, decl: *const Node) bool {
    if (decl.data != .var_decl) return false;
    const initializer = decl.data.var_decl.init orelse return false;
    const list = decl.parent orelse return false;
    if (list.data != .var_list or member.isVarDeclarationList(list)) return false;
    var outermost: ?*const Node = null;
    var cursor = node.parent;
    while (true) {
        const n = cursor orelse return false;
        if (n == initializer) break;
        if (api.isFunctionLike(n)) outermost = n;
        cursor = n.parent;
    }
    if (api.isFunctionLike(initializer)) outermost = initializer;
    var walk = outermost orelse return true;
    while (walk != initializer) {
        const parent = walk.parent orelse return true;
        if (!passesOnUncalled(parent, walk)) return true;
        walk = parent;
    }
    return false;
}

fn passesOnUncalled(parent: *const Node, child: *const Node) bool {
    return switch (parent.data) {
        .paren, .as_expr, .satisfies_expr, .non_null, .array_lit => true,
        .conditional => |x| child != x.cond,
        .binary => |x| x.op == .pipe2 or x.op == .amp2 or x.op == .qq or x.op == .comma,
        .property_assign => |x| child == x.value,
        .object_lit => child.data != .spread_assign,
        else => false,
    };
}

fn gateDeclarationList(g: *Gate, list: *Node) Result {
    if (!member.isVarDeclarationList(list) or g.mode != .ts) return accept;
    return api.never("STA1104", "var is not allowed in ts mode; use let or const instead");
}

pub fn bindingElementKey(g: *Gate, el: *Node) ?[]const u8 {
    const x = el.data.binding_elem;
    const name = x.prop_name orelse return if (api.isIdentifier(x.name)) api.text(x.name) else null;
    return types.staticPropertyName(g, name);
}

pub fn isSimpleBindingPattern(g: *Gate, name: *Node) bool {
    switch (name.data) {
        .identifier => return true,
        .object_pattern => |x| {
            for (x.elems) |el| {
                const e = el.data.binding_elem;
                const simple = if (e.dotdotdot)
                    (api.isIdentifier(e.name) or isSimpleBindingPattern(g, e.name)) and e.init == null
                else
                    bindingElementKey(g, el) != null and isSimpleBindingPattern(g, e.name);
                if (!simple) return false;
            }
            return true;
        },
        .array_pattern => |x| {
            for (x.elems) |el| {
                if (el.data == .omitted_expr) continue;
                if (el.data != .binding_elem) return false;
                const e = el.data.binding_elem;
                const simple = if (e.dotdotdot)
                    (api.isIdentifier(e.name) or isSimpleBindingPattern(g, e.name)) and e.init == null
                else
                    isSimpleBindingPattern(g, e.name);
                if (!simple) return false;
            }
            return true;
        },
        else => return false,
    }
}

fn gateDeclaration(g: *Gate, decl: *Node) Result {
    const x = decl.data.var_decl;
    if (!isSimpleBindingPattern(g, x.name)) {
        return g.notYet("a computed key with a runtime name in a destructuring declaration is not yet supported", 5);
    }
    if (api.ast.writtenType(decl, x.type) != null and x.init != null) {
        const announced = types.outSlotInner(g, g.typeFromNode(x.type.?)) != null;
        const held = types.outSlotInner(g, g.typeAt(x.init.?)) != null;
        if (announced != held) {
            return api.never("STA1125", "an Out<T> annotation must agree with its initializer — a slot is not a value of any other type (docs/FFI.md)");
        }
    }
    return accept;
}
