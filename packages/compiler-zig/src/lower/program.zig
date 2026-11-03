//! The whole program into one HIR module: per file, imports then hoists then specializations then
//! statements, dependencies before their importers.
const std = @import("std");
const stator_ts = @import("stator_ts");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Symbol = c.Symbol;
const File = c.File;
const Scope = c.Scope;
const Expression = c.Expression;
const Statement = c.Statement;
const StmtList = c.StmtList;
const HType = c.HType;
const E = c.E;
const H = c.H;
const N = c.N;
const api = c.api;
const gt = c.gt;
const boundary = @import("boundary.zig");
const statements_mod = @import("statements.zig");
const expressions = @import("expressions.zig");
const hoist = @import("hoist.zig");
const functions = @import("functions.zig");
const classes = @import("classes.zig");
const specialize = @import("specialize.zig");
const frontend_modules = @import("../frontend/modules.zig");
const ast_walk = @import("../support/ast_walk.zig");
const module_names = @import("module_names.zig");
const ExportTarget = module_names.ExportTarget;
const DEFAULT_EXPORT_BINDING = module_names.DEFAULT_EXPORT_BINDING;

pub const Binding = struct { name: []const u8, type: *const HType };

pub const Result = struct {
    module: ?*const N.Module,
    diagnostics: []const c.Diagnostic,
};

fn topLevelNames(l: *Lower, file: *File) []const []const u8 {
    var names: std.ArrayList([]const u8) = .empty;
    for (file.root.data.source_file.stmts) |statement| switch (statement.data) {
        .var_stmt => |x| for (x.list.data.var_list.decls) |decl| {
            const name = decl.data.var_decl.name;
            if (name.data == .identifier) l.push(&names, name.data.identifier);
        },
        .func => |f| if (f.kind == .decl) {
            if (module_names.declaredBindingName(statement)) |name| l.push(&names, name);
        },
        .class => |x| if (!x.is_expr) {
            if (module_names.declaredBindingName(statement)) |name| l.push(&names, name);
        },
        .export_assign => l.push(&names, DEFAULT_EXPORT_BINDING),
        else => {},
    };
    return names.items;
}

pub fn exportedBinding(l: *Lower, target_opt: ?ExportTarget, root: *Scope) ?Binding {
    const target = target_opt orelse return null;
    switch (target) {
        .namespace => |file| {
            const name = l.namespace_objects.get(file) orelse return null;
            return .{ .name = name, .type = root.get(name) orelse return null };
        },
        .binding => |x| {
            const scope = l.module_scopes.get(x.file) orelse return null;
            return .{ .name = scope.hirName(x.name), .type = scope.get(x.name) orelse return null };
        },
    }
}

pub fn moduleExportTarget(l: *Lower, module: *File, name: []const u8) ?ExportTarget {
    const symbol = l.session().moduleOf(module) orelse return null;
    for (l.session().exportsOfModule(symbol)) |candidate| {
        if (c.eql(api.symbolName(candidate) orelse "", name)) return module_names.exportTarget(l, candidate);
    }
    return null;
}

const Imports = struct {
    l: *Lower,
    file: *File,
    scope: *Scope,
    root: *Scope,
    statements: *StmtList,

    fn fail(i: *const Imports, node: *const Node, message: []const u8) E {
        return i.l.internal(node, "STA4031", message);
    }

    fn ensureNamespace(i: *const Imports, module: *File, at: *Node) E!void {
        const l = i.l;
        if (l.namespace_objects.contains(module)) return;
        const symbol = l.session().moduleOf(module) orelse return;
        const ns_type = l.toH(l.g.typeOfSymbol(symbol));
        if (ns_type.* != .object or ns_type.object.namespace != true) return;
        var entries: std.ArrayList(N.ObjectEntry) = .empty;
        const span = l.span(at);
        for (ns_type.object.fields) |field| {
            const target = moduleExportTarget(l, module, field.name);
            if (target) |t| if (t == .namespace) try i.ensureNamespace(t.namespace, at);
            const binding = exportedBinding(l, target, i.root) orelse return i.fail(at, l.fmt("export '{s}' of '{s}' has no binding", .{ field.name, module.path }));
            l.push(&entries, N.ObjectEntry{ .name = field.name, .value = l.ident(binding.type, span, binding.name) });
        }
        const name = l.concat(&.{ "\x00namespace:", module.path });
        i.root.set(name, ns_type);
        l.namespace_objects.put(l.a, module, name) catch c.oom();
        const value = l.ex(.object_literal, .{ .type = ns_type, .span = span, .entries = entries.items, .methods = &.{}, .method_copies = &.{} });
        l.push(i.statements, l.st(.declaration, .{ .type = ns_type, .span = span, .name = name, .decl_kind = .@"const", .value = value }));
    }

    fn bindName(i: *const Imports, local: *Node) E!void {
        const l = i.l;
        const target = module_names.exportTarget(l, l.g.symbolAt(local));
        if (target) |t| if (t == .namespace) try i.ensureNamespace(t.namespace, local);
        if (exportedBinding(l, target, i.root)) |binding| i.scope.alias(local.data.identifier, binding.name, binding.type);
    }
};

/// The module an `import("…")` call loads, when it is a source file and not declarations.
fn importCallTarget(l: *Lower, node: *Node) ?*File {
    if (node.data != .call) return null;
    const call = node.data.call;
    if (call.callee.data != .import_kw or call.args.len == 0 or call.args[0].data != .string_lit) return null;
    const target = l.g.declarationOf(l.g.symbolAt(call.args[0]) orelse return null) orelse return null;
    if (target.data != .source_file) return null;
    const file = l.fileOfNode(target);
    return if (file.is_dts) null else file;
}

fn bindImports(l: *Lower, file: *File, scope: *Scope, root: *Scope, statements: *StmtList) E!void {
    const i: Imports = .{ .l = l, .file = file, .scope = scope, .root = root, .statements = statements };
    for (frontend_modules.valueImportNames(l.a, file.root)) |name| try i.bindName(name);
    const targets = ast_walk.collect(*File, l.a, file.root, l, importCallTarget) catch c.oom();
    for (targets) |target| try i.ensureNamespace(target, file.root);
}

pub fn lowerImportCall(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const call = node.data.call;
    const spec: ?*Node = if (call.args.len > 0 and call.args[0].data == .string_lit) call.args[0] else null;
    const span = l.span(node);
    const target: ?*Node = if (spec) |s| if (l.g.symbolAt(s)) |symbol| l.g.declarationOf(symbol) else null else null;
    const result_type = expressions.typeAt(l, node, b);
    const ns_type: ?*const HType = if (result_type.* == .promise and result_type.promise.value.* == .object)
        result_type.promise.value
    else if (result_type.* == .object) result_type else null;
    const object: ?[]const u8 = if (target) |t| if (t.data == .source_file) l.namespace_objects.get(l.fileOfNode(t)) else null else null;
    const object_type: ?*const HType = if (object) |o| b.get(o) else null;
    if (ns_type == null or ns_type.?.object.namespace != true or object == null or object_type == null) {
        const text: []const u8 = if (spec) |s| s.data.string_lit else "";
        return l.internal(node, "STA4031", l.fmt("import('{s}') did not resolve to a module namespace", .{text}));
    }
    return l.ex(.promise_static, .{
        .type = if (result_type.* == .promise) result_type else l.hPromise(ns_type.?),
        .span = span,
        .method = .resolve,
        .arg = l.ident(object_type.?, span, object.?),
    });
}

fn lowerExportAssignment(l: *Lower, node: *Node, b: *Scope) E!Statement {
    const value = try expressions.lowerExpression(l, node.data.export_assign.expr, b);
    const name = b.declare(DEFAULT_EXPORT_BINDING, value.getType());
    return l.st(.declaration, .{ .type = value.getType(), .span = l.span(node), .name = name, .decl_kind = .@"const", .value = statements_mod.withDisplayName(l, value, "default") });
}

fn lowerFiles(l: *Lower, files: []const *File, bindings: *Scope, statements: *StmtList) E!void {
    const entry = files[files.len - 1];
    const entry_scope = bindings.child();
    entry_scope.claim(topLevelNames(l, entry));
    for (files) |file| {
        l.sf = file;
        const collected = try specialize.collectSpecializations(l, file);
        const specializations = specialize.unbound(l, specialize.Specialization, collected.functions, bindings);
        const class_specs = specialize.unbound(l, specialize.ClassSpecialization, collected.classes, bindings);
        l.current_file_class_specs = collected.classes;
        const scope = if (file == entry) entry_scope else bindings.child();
        l.module_scopes.put(l.a, file, scope) catch c.oom();
        try bindImports(l, file, scope, bindings, statements);
        const stmts = file.root.data.source_file.stmts;
        hoist.hoistFunctionDeclarations(l, stmts, scope);
        for (specializations) |spec| bindings.set(spec.name, specialize.specializationType(l, spec));
        for (class_specs) |spec| bindings.set(spec.name, classes.classSpecType(l, spec));
        const hoisted = hoist.hoistVarDeclarations(l, file.root, true, scope);
        for (specializations) |spec| {
            const home = l.module_scopes.get(l.fileOfNode(spec.declaration)) orelse scope;
            l.push(statements, try specialize.lowerSpecialization(l, spec, home));
        }
        for (class_specs) |spec| {
            if (l.fileOfNode(spec.declaration) == file) continue;
            const home = l.module_scopes.get(l.fileOfNode(spec.declaration)) orelse scope;
            l.push(statements, try classes.lowerClassSpecialization(l, spec, home));
        }
        l.a_appendAll(statements, hoisted);
        for (stmts) |node| {
            if (node.data == .func and node.data.func.kind == .decl and specialize.isGenericDeclaration(node)) continue;
            if (node.data == .class and !node.data.class.is_expr and specialize.isGenericClass(node)) {
                const own = specialize.specsOf(l, class_specs, node);
                l.a_appendAll(statements, try classes.lowerGenericClassDeclaration(l, node, own, scope));
                continue;
            }
            switch (node.data) {
                .export_assign => {
                    l.push(statements, try lowerExportAssignment(l, node, scope));
                    continue;
                },
                .import_decl, .export_decl, .interface, .type_alias => continue,
                else => {},
            }
            l.push(statements, try statements_mod.lowerStatement(l, node, scope, null));
        }
    }
}

pub const Input = struct {
    g: *c.Gate,
    session: stator_ts.Session,
    /// Dependencies first; the entry is last.
    files: []const *File,
    /// Fully qualified names of the checker-proved inconsistent bindings.
    runtime_dynamic: []const []const u8 = &.{},
    remap: ?c.SpanRemap = null,
};

pub fn lowerProgram(a: std.mem.Allocator, input: Input) Result {
    const files = input.files;
    const entry = files[files.len - 1];
    const l = a.create(Lower) catch c.oom();
    l.* = .{ .a = a, .g = input.g, .prog = input.session.prog, .checked = input.session, .sf = entry, .span_remap = input.remap, .program_modules = files };
    const bindings = Scope.root(a, &l.shadow_counter);
    var dynamic: boundary.Names = .empty;
    for (input.runtime_dynamic) |name| dynamic.put(a, name, {}) catch c.oom();
    const dynamic_returns = boundary.collectDynamicWidening(l, files, &dynamic);
    l.has_runtime_dynamic_symbols = dynamic.count() > 0;
    var keys = dynamic.keyIterator();
    while (keys.next()) |key| bindings.set(l.concat(&.{ "\x00dynamic:", key.* }), c.hUnknown(false));
    l.has_dynamic_return_symbols = dynamic_returns.count() > 0;
    var return_keys = dynamic_returns.keyIterator();
    while (return_keys.next()) |key| bindings.set(l.concat(&.{ "\x00dynamic-return:", key.* }), c.hUnknown(false));
    for (files[0 .. files.len - 1], 0..) |file, ordinal| l.dependency_ordinals.put(a, file, @intCast(ordinal)) catch c.oom();

    var statements: StmtList = .empty;
    lowerFiles(l, files, bindings, &statements) catch return .{ .module = null, .diagnostics = l.diagnostics.items };
    var env_vars: std.ArrayList([]const u8) = .empty;
    for (files) |file| {
        const info = l.capturesFor(file).get(file.root) orelse continue;
        l.a_appendAll(&env_vars, functions.envNames(l, &info));
    }
    l.sf = entry;
    const module = l.create(N.Module{
        .type = c.H_UNDEFINED,
        .span = l.makeSpan(0, @intCast(entry.src.len)),
        .file_name = entry.path,
        .statements = statements.items,
        .is_async = l.module_awaits,
        .env_vars = env_vars.items,
    });
    return .{ .module = module, .diagnostics = l.diagnostics.items };
}
