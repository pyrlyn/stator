//! The generic questions the gate asks: whether a function value has a stable specialization key, and
//! which tuple a call instantiates. The lowering owns the specializations themselves.

const std = @import("std");
const api = @import("gate_api.zig");
const support = @import("../support/root.zig");
const ast_walk = support.ast_walk;
const node_field = support.node_field;
const types = @import("gate_types.zig");
const H = @import("../hir/types.zig");
const Gate = api.Gate;
const Node = api.Node;
const Symbol = api.Symbol;
const Type = api.Type;
const HType = H.HType;
const F = api.F;
const Tok = api.Tok;
const eql = api.eql;
const oom = api.oom;

pub const Substitution = struct {
    map: std.StringHashMapUnmanaged(*const HType) = .empty,

    pub fn lookup(s: *const Substitution, name: []const u8) ?*const HType {
        return s.map.get(name);
    }

    pub fn put(s: *Substitution, g: *Gate, name: []const u8, t: *const HType) void {
        s.map.put(g.a, name, t) catch oom();
    }
};

pub const Parameter = struct { name: []const u8, default: ?*const HType };

pub const Seen = std.StringHashMapUnmanaged(void);

pub const Instantiation = union(enum) {
    not_generic,
    generic: []const *const HType,
};

fn typeParamCount(fn_: *const Node) usize {
    return fn_.data.func.type_params.items.len;
}

fn isGenericFunctionValue(n: *const Node) bool {
    return (api.isFunctionExpression(n) or api.isArrowFunction(n)) and typeParamCount(n) > 0;
}

fn sourceFileOf(n: *const Node) *const Node {
    var at = n;
    while (at.parent) |p| at = p;
    return at;
}

fn isWriteTarget(node: *const Node) bool {
    const parent = node.parent orelse return false;
    return switch (parent.data) {
        .binary => |x| x.left == node and x.op == .assign,
        inline .prefix, .postfix => |x| x.op == .plus2 or x.op == .minus2,
        inline .for_in, .for_of => |x| x.init == node,
        else => false,
    };
}

const BindingWrite = struct { g: *Gate, name: *Node, symbol: *Symbol };

fn writeStep(s: BindingWrite, node: *Node) ast_walk.Step {
    const writes = api.isIdentifier(node) and node != s.name and isWriteTarget(node) and s.g.symbolAt(node) == s.symbol;
    return if (writes) .match else .descend;
}

fn isSingleAssignmentBinding(g: *Gate, declaration: *Node) bool {
    const name = declaration.data.var_decl.name;
    const symbol = g.symbolAt(name) orelse return false;
    return !ast_walk.contains(@constCast(sourceFileOf(declaration)), BindingWrite{ .g = g, .name = name, .symbol = symbol }, writeStep);
}

pub fn positionGenericKey(g: *Gate, fn_: *Node, home: ?[]const u8) []const u8 {
    const file = g.fileOf(fn_) orelse return "";
    const base = if (std.mem.lastIndexOfScalar(u8, file.path, '/')) |at| file.path[at + 1 ..] else file.path;
    const kind = home orelse (if (api.isArrowFunction(fn_)) "arrow" else "fn");
    return g.fmt("{s}@{s}#{d}", .{ kind, base, support.diagnostics.positionOf(file.src, fn_.start).utf16_offset });
}

/// A const at module scope is named by itself; anything else needs the position to stay unique.
pub fn genericArrowKey(g: *Gate, node: *Node) ?[]const u8 {
    const fn_ = api.skipParens(node);
    if (!isGenericFunctionValue(fn_)) return null;
    const declaration = api.outermostParen(fn_).parent orelse return null;
    if (declaration.data != .var_decl or !api.isIdentifier(declaration.data.var_decl.name)) return null;
    const list = declaration.parent orelse return null;
    if (list.data != .var_list or list.data.var_list.decls.len != 1) return null;
    const is_const = isConstList(list);
    if (!is_const and !isSingleAssignmentBinding(g, declaration)) return null;
    const statement = list.parent orelse return null;
    if (statement.data != .var_stmt) return null;
    const name = api.text(declaration.data.var_decl.name) orelse "";
    if (is_const and statement.parent != null and api.isSourceFile(statement.parent.?)) return name;
    return positionGenericKey(g, fn_, name);
}

/// `using` carries neither flag in TypeScript, `await using` carries Const: flags, not spelling.
fn isConstList(list: *const Node) bool {
    return switch (list.data.var_list.kind) {
        .@"const", .await_using => true,
        else => false,
    };
}

fn isSingleConstList(list: ?*const Node) bool {
    const l = list orelse return false;
    return l.data == .var_list and isConstList(l) and l.data.var_list.decls.len == 1;
}

pub fn genericAliasTarget(g: *Gate, node: *Node) ?*Node {
    var seen: std.AutoHashMapUnmanaged(*Symbol, void) = .empty;
    var current = node;
    while (api.isIdentifier(current)) {
        var symbol = g.symbolAt(current) orelse return null;
        if (symbol.flags & F.alias != 0) symbol = g.aliased(symbol) orelse return null;
        const entry = seen.getOrPut(g.a, symbol) catch oom();
        if (entry.found_existing) return null;
        const declaration = api.valueDeclaration(symbol) orelse return null;
        if (api.isFunctionDeclaration(declaration) or api.isFunctionExpression(declaration) or api.isArrowFunction(declaration)) {
            if (typeParamCount(declaration) > 0) {
                if (!api.isFunctionDeclaration(declaration) and genericArrowKey(g, declaration) == null) return null;
                return declaration;
            }
        }
        if (declaration.data != .var_decl) return null;
        const x = declaration.data.var_decl;
        const initializer = x.init orelse return null;
        if (!api.isIdentifier(x.name)) return null;
        const init = api.skipParens(initializer);
        if (isGenericFunctionValue(init)) return if (genericArrowKey(g, initializer) == null) null else init;
        if (!api.isIdentifier(init)) return null;
        if (!isSingleConstList(declaration.parent)) return null;
        current = initializer;
    }
    return null;
}

pub fn keyOf(g: *Gate, fn_: *Node) ?[]const u8 {
    if (api.isFunctionDeclaration(fn_)) {
        const name = fn_.data.func.name orelse return "";
        return api.text(name) orelse "";
    }
    return genericArrowKey(g, fn_);
}

pub fn genericValueInstantiation(g: *Gate, node: *Node) bool {
    const target = genericAliasTarget(g, node) orelse return false;
    if (g.signatureOf(target).tparams.len == 0) return false;
    return keyOf(g, target) != null;
}

fn defaultOf(g: *Gate, t: *Type) ?*const HType {
    const declared = api.decls.defaultOf(g.c, t) orelse return null;
    return types.tsTypeToHType(g, declared);
}

pub fn parameterDefaults(g: *Gate, parameters: []const *Type) []const Parameter {
    const out = g.a.alloc(Parameter, parameters.len) catch oom();
    for (parameters, out) |t, *slot| slot.* = .{ .name = t.data.param.name, .default = defaultOf(g, t) };
    return out;
}

pub fn finishTuple(g: *Gate, parameters: []const Parameter, substitution: *Substitution) []const *const HType {
    const out = g.a.alloc(*const HType, parameters.len) catch oom();
    for (parameters, out) |parameter, *slot| {
        if (substitution.lookup(parameter.name) == null) {
            const filled: *const HType = if (parameter.default) |d|
                H.substituteHType(g.a, d, substitution) catch oom()
            else
                H.hUnknown(false);
            substitution.put(g, parameter.name, filled);
        }
        const bound = substitution.lookup(parameter.name) orelse H.hUnknown(false);
        slot.* = H.substituteHType(g.a, bound, substitution) catch oom();
    }
    return out;
}

fn unifyNamedMembers(g: *Gate, declared: []const H.HField, concrete: []const H.HField, out: *Substitution, seen: *Seen) void {
    for (declared) |member| {
        for (concrete) |match| {
            if (eql(match.name, member.name)) {
                unify(g, member.type, match.type, out, seen);
                break;
            }
        }
    }
}

fn fieldNames(g: *Gate, o: H.HObject) []const u8 {
    var names: std.ArrayList(u8) = .empty;
    for (o.fields, 0..) |f, i| names.print(g.a, "{s}{s}", .{ if (i == 0) "" else ",", f.name }) catch oom();
    for (o.methods, 0..) |f, i| names.print(g.a, "{s}{s}", .{ if (i == 0 and o.fields.len == 0) "" else ",", f.name }) catch oom();
    return names.items;
}

pub fn unify(g: *Gate, declared: *const HType, concrete: *const HType, out: *Substitution, seen: *Seen) void {
    switch (declared.*) {
        .type_param => |p| if (out.lookup(p.name) == null) out.put(g, p.name, concrete),
        .array => |d| if (concrete.* == .array) unify(g, d.element, concrete.array.element, out, seen),
        .set => |d| if (concrete.* == .set) unify(g, d.element, concrete.set.element, out, seen),
        .map => |d| if (concrete.* == .map) {
            unify(g, d.key, concrete.map.key, out, seen);
            unify(g, d.value, concrete.map.value, out, seen);
        },
        .@"fn" => |d| if (concrete.* == .@"fn") {
            const c = concrete.@"fn";
            for (d.params, 0..) |p, i| {
                if (i < c.params.len) unify(g, p, c.params[i], out, seen);
            }
            unify(g, d.ret, c.ret, out, seen);
        },
        .object => |d| if (concrete.* == .object) {
            const c = concrete.object;
            if (!eql(d.name, c.name) or d.namespace != c.namespace) return;
            const pair = g.fmt("{s}◊{s}◊{s}", .{ d.name, fieldNames(g, d), fieldNames(g, c) });
            if ((seen.getOrPut(g.a, pair) catch oom()).found_existing) return;
            unifyNamedMembers(g, d.fields, c.fields, out, seen);
            unifyNamedMembers(g, d.methods, c.methods, out, seen);
        },
        else => {},
    }
}

const BindReferences = struct {
    g: *Gate,
    out: *Substitution,
    seen: std.AutoHashMapUnmanaged(*Type, void) = .empty,

    fn visit(s: *BindReferences, t: *Type) void {
        const g = s.g;
        if ((s.seen.getOrPut(g.a, t) catch oom()).found_existing) return;
        const args = referenceArguments(t);
        if (args) |list| {
            if (api.valueDeclaration(api.typeSymbol(t))) |declaration| {
                if (api.isClassDeclaration(declaration)) {
                    for (declaration.data.class.type_params.items, 0..) |parameter, i| {
                        if (i >= list.len) break;
                        const name = api.text(parameter.data.type_param.name) orelse "";
                        if (s.out.lookup(name) == null) {
                            s.out.put(g, name, types.tsTypeToHType(g, list[i]));
                            s.visit(list[i]);
                        }
                    }
                }
            }
        }
        if (api.isUnionType(t)) {
            for (api.parts(g, t)) |part| s.visit(part);
            return;
        }
        if (args) |list| for (list) |arg| s.visit(arg);
    }
};

/// `(type as ts.TypeReference).typeArguments`: present on references only, unlike `checker.getTypeArguments`.
pub fn referenceArguments(t: *Type) ?[]*Type {
    if (t.data != .obj) return null;
    return t.data.obj.args;
}

pub fn argumentTypesOf(g: *Gate, args: []const *Node, n: *Node) []const *Type {
    var out: std.ArrayList(*Type) = .empty;
    for (args) |arg| out.append(g.a, g.typeAt(arg)) catch oom();
    if (g.resolvedSignature(n)) |resolved| out.append(g.a, g.returnType(resolved)) catch oom();
    return out.items;
}

pub fn bindReferenceArguments(g: *Gate, list: []const *Type, out: *Substitution) void {
    var binder = BindReferences{ .g = g, .out = out };
    for (list) |t| binder.visit(t);
}

fn paramDeclaration(symbol: ?*Symbol) ?*Node {
    const declaration = api.valueDeclaration(symbol) orelse return null;
    return if (declaration.data == .param) declaration else null;
}

/// JSDoc's `[x]` and `{T=}` make a parameter optional without the `?` that tsc's AST would show.
fn writtenQuestion(declaration: *const Node) bool {
    const p = declaration.data.param;
    return p.question and (p.type == null or api.ast.writtenType(declaration, p.type) != null);
}

fn isOmissibleParameter(symbol: ?*Symbol) bool {
    const declaration = paramDeclaration(symbol) orelse return false;
    const p = declaration.data.param;
    return writtenQuestion(declaration) or p.init != null;
}

fn paramType(g: *Gate, p: api.T.SigParam) *const HType {
    return types.tsTypeToHType(g, p.ty orelse g.c.t_err);
}

fn declaredParamType(g: *Gate, p: api.T.SigParam) *const HType {
    if (paramDeclaration(p.sym)) |declaration| {
        const x = declaration.data.param;
        if ((writtenQuestion(declaration) or x.init != null) and api.ast.writtenType(declaration, x.type) != null) {
            const annotated = g.typeFromNode(x.type.?);
            if (!api.isUnionType(annotated)) return types.tsTypeToHType(g, annotated);
            var concrete: ?*Type = null;
            var count: usize = 0;
            for (api.parts(g, annotated)) |t| {
                if (t.data == .undefined) continue;
                concrete = t;
                count += 1;
            }
            if (count == 1) return types.tsTypeToHType(g, concrete.?);
        }
    }
    return paramType(g, p);
}

pub fn unifyCallArguments(g: *Gate, args: []const *Node, declared: []const api.T.SigParam, resolved: []const api.T.SigParam, substitution: *Substitution) void {
    var seen: Seen = .empty;
    for (declared, 0..) |declared_param, i| {
        if (i >= resolved.len) continue;
        const omissible = isOmissibleParameter(declared_param.sym);
        const passed: ?*Node = if (omissible and i < args.len) args[i] else null;
        const argument: ?*Node = if (passed != null and passed.?.data == .spread_elem) null else passed;
        if (omissible and argument == null) continue;
        const concrete = if (argument) |a| types.tsTypeToHType(g, g.typeAt(a)) else paramType(g, resolved[i]);
        unify(g, declaredParamType(g, declared_param), concrete, substitution, &seen);
    }
}

/// The whole answer: the lowering specializes on it, the gate only reads the tuple.
pub const Generic = struct {
    declaration: *Node,
    key: []const u8,
    type_arguments: []const *const HType,
    substitution: *Substitution,
};

pub fn genericCallInstantiation(g: *Gate, call: *Node) Instantiation {
    const found = genericCall(g, call) orelse return .not_generic;
    return .{ .generic = found.type_arguments };
}

pub fn genericCall(g: *Gate, call: *Node) ?Generic {
    const resolved = g.resolvedSignature(call) orelse return null;
    const declaration = resolved.decl orelse return null;
    if (!api.isFunctionDeclaration(declaration) and !api.isFunctionExpression(declaration) and !api.isArrowFunction(declaration)) return null;
    const key = keyOf(g, declaration) orelse return null;
    const declared = g.signatureOf(declaration);
    if (declared.tparams.len == 0) return null;
    const args = api.nodes(call.data.call.args);
    const substitution = g.a.create(Substitution) catch oom();
    substitution.* = .{};
    bindReferenceArguments(g, argumentTypesOf(g, args, call), substitution);
    unifyCallArguments(g, args, declared.params, resolved.params, substitution);
    var seen: Seen = .empty;
    unify(g, types.tsTypeToHType(g, g.returnType(declared)), types.tsTypeToHType(g, g.returnType(resolved)), substitution, &seen);
    const type_arguments = finishTuple(g, parameterDefaults(g, declared.tparams), substitution);
    return .{ .declaration = declaration, .key = key, .type_arguments = type_arguments, .substitution = substitution };
}

pub const NewTarget = struct { class: *Node, constructor: ?*Node };

pub fn newTarget(g: *Gate, created: *Node) ?NewTarget {
    const x = created.data.new_expr;
    const resolved = g.resolvedSignature(created);
    const declaration = if (resolved) |r| r.decl else null;
    if (declaration != null and api.isConstructor(declaration.?)) {
        const parent = declaration.?.parent orelse return null;
        return if (api.isClassDeclaration(parent)) .{ .class = parent, .constructor = declaration } else null;
    }
    if (!api.isIdentifier(x.callee)) return null;
    const value = api.valueDeclaration(g.symbolAt(x.callee)) orelse return null;
    return if (api.isClassDeclaration(value)) .{ .class = value, .constructor = null } else null;
}

pub fn isGenericNew(g: *Gate, created: *Node) bool {
    const found = newTarget(g, created) orelse return false;
    return found.class.data.class.type_params.items.len > 0;
}

pub fn instantiatesAtParameter(g: *Gate, generic: *Node, argument: *Node, outer_call: *Node) bool {
    const outer = g.resolvedSignature(outer_call) orelse return false;
    const args = api.nodes(outer_call.data.call.args);
    const index = std.mem.indexOfScalar(*Node, args, argument) orelse return false;
    if (index >= outer.params.len) return false;
    const parameter = outer.params[index];
    const declaration = paramDeclaration(parameter.sym) orelse return false;
    if (declaration.data.param.dotdotdot) return false;
    if (g.signatureOf(generic).tparams.len == 0) return false;
    const declared_fn = types.tsTypeToHType(g, g.typeAt(generic));
    return declared_fn.* == .@"fn" and paramType(g, parameter).* == .@"fn";
}

/// Definedness only: the gate never reads the tuple of an inline generic function.
pub fn inlineGenericTuple(g: *Gate, argument: *Node) ?void {
    const unwrapped = api.skipParens(argument);
    if (!isGenericFunctionValue(unwrapped)) return null;
    const current = api.outermostParen(unwrapped);
    const parent = current.parent orelse return null;
    if (parent.data != .call or parent.data.call.callee == current) return null;
    if (std.mem.indexOfScalar(*Node, api.nodes(parent.data.call.args), current) == null) return null;
    if (capturesEnclosingScope(g, unwrapped)) return null;
    return if (instantiatesAtParameter(g, unwrapped, current, parent)) {} else null;
}

fn bindsOwnName(parent: *const Node, child: *const Node) bool {
    return switch (parent.data) {
        .func => |x| switch (x.kind) {
            .decl, .expr, .method, .getter, .setter, .method_sig, .getter_sig, .setter_sig => x.name == child,
            else => false,
        },
        .class, .var_decl, .param, .type_param, .interface, .type_alias, .enum_decl, .module_decl, .property_decl, .property_sig, .enum_member => ownName(parent) == child,
        else => false,
    };
}

fn ownName(declaration: *const Node) ?*Node {
    return node_field.of(?*Node, declaration, .{
        .{ .class, "name" },         .{ .var_decl, "name" },     .{ .param, "name" },       .{ .type_param, "name" },
        .{ .interface, "name" },     .{ .type_alias, "name" },   .{ .enum_decl, "name" },   .{ .module_decl, "name" },
        .{ .property_decl, "name" }, .{ .property_sig, "name" }, .{ .enum_member, "name" },
    });
}

fn isValueReference(node: *const Node) bool {
    const parent = node.parent orelse return true;
    switch (parent.data) {
        .prop_access => |x| if (x.name == node) return false,
        .shorthand_assign => return true,
        .property_assign => |x| if (x.name == node) return false,
        .labeled => return false,
        inline .break_stmt, .continue_stmt => |x| if (x.label == node) return false,
        else => {},
    }
    return !bindsOwnName(parent, node);
}

fn containsNode(ancestor: *const Node, descendant: *const Node) bool {
    return descendant.start >= ancestor.start and descendant.end <= ancestor.end;
}

fn isScopeBoundary(node: *const Node) bool {
    return api.hasOwnBody(node) or switch (node.data) {
        .class, .enum_decl, .module_decl, .block, .module_block, .catch_clause, .for_stmt, .for_in, .for_of, .while_stmt, .do_stmt, .switch_stmt => true,
        else => false,
    };
}

fn isModuleVisible(declaration: *const Node, fn_: *const Node) bool {
    if (containsNode(fn_, declaration)) return true;
    var current = declaration.parent;
    while (current) |at| {
        if (api.isSourceFile(at)) return true;
        if (isScopeBoundary(at)) return false;
        current = at.parent;
    }
    return true;
}

fn isSpecializationBlindSpot(declaration: *const Node, fn_: *const Node) bool {
    if (declaration.data != .var_decl or containsNode(fn_, declaration)) return false;
    return sourceFileOf(declaration) == sourceFileOf(fn_);
}

const Capture = struct { g: *Gate, fn_: *Node };

fn captureStep(s: Capture, node: *Node) ast_walk.Step {
    if (api.isTypeNode(node)) return .skip;
    switch (node.data) {
        .this_expr, .super_expr => return .match,
        .meta_property => |x| return if (x.keyword == .kw_new) .match else .skip,
        else => {},
    }
    if (api.isIdentifier(node) and isValueReference(node)) {
        if (api.valueDeclaration(s.g.symbolAt(node))) |declaration| {
            if (!isModuleVisible(declaration, s.fn_) or isSpecializationBlindSpot(declaration, s.fn_)) return .match;
        }
    }
    return .descend;
}

pub fn capturesEnclosingScope(g: *Gate, fn_: *Node) bool {
    return ast_walk.contains(fn_, Capture{ .g = g, .fn_ = fn_ }, captureStep);
}
