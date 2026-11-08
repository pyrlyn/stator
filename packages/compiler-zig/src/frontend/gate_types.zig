//! What the gate needs from `packages/compiler/src/frontend/types.ts`: the mapping from a checker type
//! to an HType, and the class questions the mapping rests on. Lowering is a later wave, so this holds
//! the subset the gate calls, under the same names, for the port of `types.ts` to absorb.

const std = @import("std");
const api = @import("gate_api.zig");
const hir = @import("../hir/root.zig");
const node_field = @import("../support/node_field.zig");
const ast_walk = @import("../support/ast_walk.zig");
const globals = @import("gate_globals.zig");
const H = hir.types;
const nodes = hir.nodes;
const HType = H.HType;
const HField = H.HField;
const Gate = api.Gate;
const Node = api.Node;
const Type = api.Type;
const Symbol = api.Symbol;
const Prop = api.Prop;
const F = api.F;
const decls = api.decls;
const eql = api.eql;
const oom = api.oom;

const max_signature_depth = 4;
pub const default_export_binding = "*default*";
pub const iterator_method_name = "__@iterator";

pub fn isBrandedPointer(g: *Gate, t: *Type) bool {
    if (t.data != .obj) return false;
    const properties = g.properties(t);
    if (properties.len != 1 or !eql(properties[0].name, "__brand")) return false;
    const prop: *Prop = @constCast(properties[0]);
    if (api.propDeclaration(prop) == null) return false;
    return g.propType(prop).data == .str_lit;
}

fn aliasName(t: *const Type) ?[]const u8 {
    return if (t.alias) |a| a.sym.resolve().name else null;
}

pub fn isOutAlias(t: *const Type) bool {
    return eql(aliasName(t) orelse return false, "Out");
}

pub fn outSlotInner(g: *Gate, t: *Type) ?*Type {
    if (!isOutAlias(t) or t.data != .obj) return null;
    const properties = g.properties(t);
    if (properties.len != 1 or !eql(properties[0].name, "value")) return null;
    const args = if (t.alias.?.args.len > 0) t.alias.?.args else g.typeArguments(t);
    if (args.len != 1) return null;
    const inner = args[0];
    if (!isBrandedPointer(g, inner) and !isCStringType(inner)) return null;
    return inner;
}

pub fn isCStringType(t: *const Type) bool {
    const alias = aliasName(t) orelse return false;
    if (!eql(alias, "CString") and !eql(alias, "CStringOwned")) return false;
    if (api.isStringLike(t)) return true;
    if (t.data == .inter) {
        for (t.data.inter) |x| if (api.isStringLike(x)) return true;
    }
    return false;
}

pub fn tsTypeToHType(g: *Gate, t: *Type) *const HType {
    return convert(g, t, 0);
}

const unknown_explicit = H.hUnknown(false);

fn convert(g: *Gate, t: *Type, depth: u32) *const HType {
    switch (t.data) {
        .number, .num_lit => return H.H_NUMBER,
        .string, .str_lit, .tmpl, .strmap => return H.H_STRING,
        .enum_lit => |e| switch (e.value) {
            .str => return H.H_STRING,
            .num => return H.H_NUMBER,
            .none => {},
        },
        else => {},
    }
    if (isCStringType(t)) return H.H_STRING;
    if (api.isBooleanLike(t)) return H.H_BOOLEAN;
    switch (t.data) {
        .undefined, .void => return H.H_UNDEFINED,
        .null => return H.H_NULL,
        .any, .err => return H.hUnknown(true),
        else => {},
    }
    if (t.data == .param) {
        if (declaredTypeParameterName(t)) |name| return H.hTypeParam(g.a, name) catch oom();
    }
    if (bounded(functionTypeToHType, g, t, depth)) |x| return x;
    if (bounded(arrayTypeToHType, g, t, depth)) |x| return x;
    if (bounded(collectionTypeToHType, g, t, depth)) |x| return x;
    if (iteratorTypeToHType(g, t, depth)) |x| return x;
    if (isLibInterface(g, t, "RegExp")) return H.H_REGEXP;
    if (isLibInterface(g, t, "Date")) return H.H_DATE;
    if (isLibInterface(g, t, "Uint8Array")) return H.H_UINT8ARRAY;
    if (isBufferType(g, t)) return H.H_ARRAYBUFFER;
    for (nodes.ERROR_CLASSES) |ctor| {
        if (isLibInterface(g, t, @tagName(ctor))) return nodes.errorHType(ctor);
    }
    if (outSlotInner(g, t) != null) return unknown_explicit;
    if (isFunctionConstructorInstance(t)) return unknown_explicit;
    if (bounded(classTypeToHType, g, t, depth)) |x| return x;
    if (t.data == .union_) {
        const list = t.data.union_;
        if (list.len == 0) return unknown_explicit;
        const first = convert(g, list[0], depth);
        for (list[1..]) |x| {
            if (!H.hTypeEquals(first, convert(g, x, depth))) return unknown_explicit;
        }
        return first;
    }
    if (bounded(moduleNamespaceToHType, g, t, depth)) |x| return x;
    if (bounded(shapeTypeToHType, g, t, depth)) |x| return x;
    return unknown_explicit;
}

/// A converter that recurses into its parts, cut off past the depth limit.
fn bounded(comptime converter: fn (*Gate, *Type, u32) ?*const HType, g: *Gate, t: *Type, depth: u32) ?*const HType {
    return if (depth >= max_signature_depth) null else converter(g, t, depth);
}

fn declaredTypeParameterName(t: *Type) ?[]const u8 {
    const sym = api.typeSymbol(t) orelse return null;
    const list = sym.resolve().decls;
    if (list.len == 0) return null;
    for (list) |d| if (d.data != .type_param) return null;
    return sym.resolve().name;
}

fn arrayTypeToHType(g: *Gate, t: *Type, depth: u32) ?*const HType {
    if (!g.isArrayType(t)) return null;
    const args = g.typeArguments(t);
    if (args.len == 0) return null;
    return H.hArray(g.a, convert(g, args[0], depth + 1)) catch oom();
}

fn isBufferType(g: *Gate, t: *Type) bool {
    if (t.data == .union_) {
        for (t.data.union_) |x| {
            if (!isLibInterface(g, x, "ArrayBuffer") and !isLibInterface(g, x, "SharedArrayBuffer")) return false;
        }
        return true;
    }
    return isLibInterface(g, t, "ArrayBuffer");
}

pub fn isLibInterface(g: *Gate, t: *Type, name: []const u8) bool {
    const sym = api.typeSymbol(t) orelse return false;
    if (!eql(sym.resolve().name, name)) return false;
    return g.declaredOnlyInDeclarationFiles(sym);
}

fn iteratorTypeToHType(g: *Gate, t: *Type, depth: u32) ?*const HType {
    const name = api.symbolName(api.typeSymbol(t)) orelse return null;
    for ([_][]const u8{ "ArrayIterator", "MapIterator", "SetIterator", "RegExpStringIterator", "Generator" }) |known| {
        if (!eql(name, known)) continue;
        if (!isLibInterface(g, t, name)) return null;
        const args = g.typeArguments(t);
        const element = if (args.len > 0) convert(g, args[0], depth + 1) else unknown_explicit;
        return H.hIterator(g.a, element) catch oom();
    }
    return null;
}

fn collectionTypeToHType(g: *Gate, t: *Type, depth: u32) ?*const HType {
    const name = api.symbolName(api.typeSymbol(t)) orelse return null;
    const is_set = eql(name, "Set") or eql(name, "WeakSet");
    const is_map = eql(name, "Map") or eql(name, "WeakMap");
    const is_promise = eql(name, "Promise");
    if (!is_set and !is_map and !is_promise) return null;
    if (!isLibInterface(g, t, name)) return null;
    const args = g.typeArguments(t);
    if (is_promise) {
        if (args.len == 0) return null;
        return H.hPromise(g.a, convert(g, args[0], depth + 1)) catch oom();
    }
    if (is_set) {
        if (args.len == 0) return null;
        return H.hSet(g.a, convert(g, args[0], depth + 1)) catch oom();
    }
    if (args.len < 2) return null;
    return H.hMap(g.a, convert(g, args[0], depth + 1), convert(g, args[1], depth + 1)) catch oom();
}

fn functionTypeToHType(g: *Gate, t: *Type, depth: u32) ?*const HType {
    const signatures = g.callSignatures(t);
    const constructs = g.constructSignatures(t);
    const chosen = if (signatures.len == 1)
        signatures[0]
    else if (constructs.len == 1)
        constructs[0]
    else
        return null;
    const params = g.a.alloc(*const HType, chosen.params.len) catch oom();
    for (chosen.params, params, 0..) |p, *out, i| {
        out.* = if (p.sym) |sym| blk: {
            if (sym.resolve().value_decl == null and !api.isPatternParameter(chosen, i)) break :blk unknown_explicit;
            break :blk convert(g, g.parameterType(chosen, i), depth + 1);
        } else if (p.ty != null or chosen.decl != null or chosen.target != null)
            convert(g, g.parameterType(chosen, i), depth + 1)
        else
            unknown_explicit;
    }
    return H.hFunction(g.a, params, convert(g, g.returnType(chosen), depth + 1)) catch oom();
}

const NameMap = std.StringHashMapUnmanaged(*const HType);

const Lookup = struct {
    map: *const NameMap,
    pub fn lookup(l: Lookup, name: []const u8) ?*const HType {
        return l.map.get(name);
    }
};

fn classTypeToHType(g: *Gate, t: *Type, depth: u32) ?*const HType {
    const sym = api.typeSymbol(t) orelse return null;
    const declaration = sym.resolve().value_decl orelse return null;
    if (!api.isClassLike(declaration)) return null;
    const class_name = classDisplayName(declaration) orelse return null;
    var fields: std.ArrayList(HField) = .empty;
    var methods: std.ArrayList(HField) = .empty;
    const chain = ancestry(g, declaration);
    // A `Uint8Array` subclass has no slots: its storage is the view's, and the lib members the
    // checker lists for it are the view's own, so only the members user classes declare are kept
    // (plan/T11.6a). The static side maps here too, as it does for every class.
    const view = extendsUint8Array(g, declaration);
    var heritage = heritageSubstitution(g, declaration, chain);
    var claimed: std.StringHashMapUnmanaged(void) = .empty;
    for (chain) |ancestor| {
        const ancestor_type = if (ancestor == declaration and api.isClassExpression(ancestor)) t else declaredTypeOf(g, ancestor) orelse continue;
        for (g.properties(ancestor_type)) |const_prop| {
            const prop: *Prop = @constCast(const_prop);
            const at = api.propDeclaration(prop);
            const raw = hirPropertyName(prop.name);
            const owner = if (std.mem.startsWith(u8, raw, "#")) privateOwnerName(prop, at, chain, ancestor) else null;
            const name = if (owner) |o| privateSlotName(g, o, raw) else raw;
            if (at == null or claimed.contains(name) or (view and g.inDeclarationFile(at.?))) continue;
            claimed.put(g.a, name, {}) catch oom();
            const member_decls = api.propDeclarations(prop);
            const owner_decl = if (at.?.parent != null and api.isClassDeclaration(at.?.parent.?)) at.?.parent.? else ancestor;
            const declared = convert(g, g.propType(prop), depth + 1);
            const value_type = if (heritage.getPtr(owner_decl)) |ground|
                H.substituteHType(g.a, declared, Lookup{ .map = ground }) catch oom()
            else
                declared;
            var getter = false;
            var setter = false;
            var method = false;
            for (member_decls) |d| {
                getter = getter or api.isGetAccessor(d);
                setter = setter or api.isSetAccessor(d);
                method = method or api.isMethodDeclaration(d);
            }
            if (getter or setter) {
                if (getter) {
                    const accessor = H.accessorName(g.a, .get, prop.name) catch oom();
                    methods.append(g.a, .{
                        .name = if (owner) |o| privateMethodName(g, o, accessor) else accessor,
                        .type = H.hFunction(g.a, &.{}, value_type) catch oom(),
                    }) catch oom();
                }
                if (setter) {
                    const accessor = H.accessorName(g.a, .set, prop.name) catch oom();
                    const params = g.a.dupe(*const HType, &.{value_type}) catch oom();
                    methods.append(g.a, .{
                        .name = if (owner) |o| privateMethodName(g, o, accessor) else accessor,
                        .type = H.hFunction(g.a, params, H.H_UNDEFINED) catch oom(),
                    }) catch oom();
                }
                continue;
            }
            if (method) {
                methods.append(g.a, .{ .name = name, .type = value_type }) catch oom();
            } else {
                fields.append(g.a, .{ .name = name, .type = value_type }) catch oom();
            }
        }
    }
    const bases = chainBaseNames(g, chain, declaration);
    // The gate admits no instance field on a view class, so `fields` is empty here.
    if (view) return H.hViewClass(g.a, .{ .name = class_name, .fields = &.{}, .methods = methods.items, .bases = bases }) catch oom();
    return H.hObject(g.a, class_name, fields.items, methods.items, bases, null) catch oom();
}

/// The descriptor names of `chain`'s ancestors (root first, `declaration` last), nearest first,
/// which is the order `hTypeAssignable` and `instanceof` read them in. An unbound base answers
/// `""` and is left out, so this stays total where the gate still refuses.
fn chainBaseNames(g: *Gate, chain: []*Node, declaration: *Node) []const []const u8 {
    var bases: std.ArrayList([]const u8) = .empty;
    var i = chain.len;
    while (i > 1) {
        i -= 1;
        const name = baseDescriptorName(g, chain[i - 1], declaration);
        if (name.len > 0) bases.append(g.a, name) catch oom();
    }
    return bases.items;
}

/// Whether the root of `declaration`'s chain extends the global `Uint8Array` (plan/T11.6a): such a
/// class's instances are views, laid out by the runtime rather than by a slot list.
pub fn extendsUint8Array(g: *Gate, declaration: *Node) bool {
    const chain = ancestry(g, declaration);
    if (chain.len == 0) return false;
    const expression = extendsExpression(chain[0]) orelse return false;
    return globals.isGlobalNamed(g, expression, "Uint8Array");
}

fn moduleNamespaceToHType(g: *Gate, t: *Type, depth: u32) ?*const HType {
    const file = namespaceModule(g, t) orelse return null;
    const modules = @import("gate_modules.zig");
    var ambiguous = modules.ambiguousStarExports(g, file);
    var fields: std.ArrayList(HField) = .empty;
    for (g.properties(t)) |const_prop| {
        const prop: *Prop = @constCast(const_prop);
        if (api.propDeclaration(prop) == null or prop.method or ambiguous.contains(prop.name)) continue;
        const prop_type = g.propType(prop);
        if (g.constructSignatures(prop_type).len > 0) continue;
        fields.append(g.a, .{ .name = prop.name, .type = convert(g, prop_type, depth + 1) }) catch oom();
    }
    if (fields.items.len == 0) return null;
    return H.hObject(g.a, shapeName(g, fields.items, &.{}), fields.items, &.{}, &.{}, true) catch oom();
}

pub fn namespaceModule(g: *const Gate, t: *Type) ?*Node {
    const sym = (api.typeSymbol(t) orelse return null).resolve();
    if (sym.flags & F.module_any == 0 or sym.flags & F.variable != 0) return null;
    const declaration = g.declarationOf(sym) orelse (if (sym.decls.len > 0) sym.decls[0] else return null);
    return if (api.isSourceFile(declaration)) declaration else null;
}

fn shapeTypeToHType(g: *Gate, t: *Type, depth: u32) ?*const HType {
    if (!api.isAnonymousShape(t) or g.callSignatures(t).len > 0 or g.constructSignatures(t).len > 0 or g.indexInfos(t).len > 0) return null;
    var fields: std.ArrayList(HField) = .empty;
    var methods: std.ArrayList(HField) = .empty;
    for (g.properties(t)) |const_prop| {
        const prop: *Prop = @constCast(const_prop);
        if (isProtoDataProperty(prop)) return null;
        if (api.propDeclaration(prop) == null or prop.optional or api.propHasAccessor(prop)) return null;
        const value_type = convert(g, g.propType(prop), depth + 1);
        var method = prop.method;
        for (api.propDeclarations(prop)) |d| method = method or api.isMethodDeclaration(d);
        if (method) {
            methods.append(g.a, .{ .name = prop.name, .type = value_type }) catch oom();
        } else {
            fields.append(g.a, .{ .name = prop.name, .type = value_type }) catch oom();
        }
    }
    if (fields.items.len == 0 and methods.items.len == 0) return null;
    return H.hObject(g.a, shapeName(g, fields.items, methods.items), fields.items, methods.items, &.{}, null) catch oom();
}

fn isProtoDataProperty(p: *Prop) bool {
    if (!eql(p.name, "__proto__")) return false;
    if (p.method) return false;
    for (api.propDeclarations(p)) |d| if (api.isMethodDeclaration(d)) return false;
    return true;
}

pub fn shapeName(g: *Gate, fields: []const HField, methods: []const HField) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    out.append(g.a, '{') catch oom();
    var first = true;
    for ([_][]const HField{ fields, methods }) |list| for (list) |f| {
        if (!first) out.appendSlice(g.a, ", ") catch oom();
        first = false;
        out.print(g.a, "{s}: {s}", .{ f.name, H.hTypeName(g.a, f.type) catch oom() }) catch oom();
    };
    out.append(g.a, '}') catch oom();
    return out.items;
}

pub fn isDynamicShape(g: *Gate, t: *Type) bool {
    if (g.isArrayType(t) or api.T.isTupleType(t)) return false;
    for (nodes.ERROR_CLASSES) |ctor| {
        if (isLibInterface(g, t, @tagName(ctor))) return false;
    }
    var structural = api.isAnonymousShape(t);
    if (!structural) {
        if (api.typeSymbol(t)) |s| structural = s.resolve().flags & F.interface != 0;
    }
    if (!structural or g.callSignatures(t).len > 0 or g.constructSignatures(t).len > 0) return false;
    const properties = g.properties(t);
    var trigger = false;
    for (properties) |const_prop| {
        const prop: *Prop = @constCast(const_prop);
        trigger = trigger or prop.optional or api.propHasAccessor(prop) or isProtoDataProperty(prop);
    }
    return trigger or g.indexInfos(t).len > 0 or properties.len == 0;
}

pub fn computedKeyStaticName(g: *Gate, name: *Node) ?[]const u8 {
    return elementStaticKey(g, name.data.computed_name.expr);
}

pub fn elementStaticKey(g: *Gate, e: *Node) ?[]const u8 {
    if (api.isStringLiteralLike(e)) return api.text(e);
    const t = g.typeAt(e);
    return switch (t.data) {
        .str_lit => |v| v,
        .num_lit => |v| decls.numName(g.c, v),
        .enum_lit => |x| switch (x.value) {
            .str => |v| v,
            .num => |v| decls.numName(g.c, v),
            .none => null,
        },
        else => null,
    };
}

pub fn numberName(g: *Gate, digits: []const u8) []const u8 {
    const value = parseNumber(digits) orelse return digits;
    return decls.numName(g.c, value);
}

/// `Number(text)` for a numeric literal, whose separators and radix prefixes `parseFloat` refuses.
pub fn parseNumber(digits: []const u8) ?f64 {
    var clean: [128]u8 = undefined;
    var len: usize = 0;
    for (digits) |b| {
        if (b == '_') continue;
        if (len == clean.len) return null;
        clean[len] = b;
        len += 1;
    }
    const s = clean[0..len];
    if (s.len > 2 and s[0] == '0') {
        const radix: ?u8 = switch (s[1]) {
            'x', 'X' => 16,
            'o', 'O' => 8,
            'b', 'B' => 2,
            else => null,
        };
        if (radix) |r| {
            var v: f64 = 0;
            for (s[2..]) |b| {
                const d = std.fmt.charToDigit(b, r) catch return null;
                v = v * @as(f64, @floatFromInt(r)) + @as(f64, @floatFromInt(d));
            }
            return v;
        }
    }
    return std.fmt.parseFloat(f64, s) catch null;
}

pub fn staticPropertyName(g: *Gate, name: *Node) ?[]const u8 {
    return switch (name.data) {
        .identifier, .string_lit, .no_subst_template => |v| v,
        .numeric_lit => |v| numberName(g, v),
        .computed_name => computedKeyStaticName(g, name),
        else => null,
    };
}

fn memberName(n: *const Node) ?*Node {
    return switch (n.data) {
        .property_assign => |x| x.name,
        .func => |x| if (x.kind == .getter or x.kind == .setter) x.name else null,
        else => null,
    };
}

fn literalHasRuntimeComputedKey(g: *Gate, literal: *Node) bool {
    for (literal.data.object_lit.props) |p| {
        const name = memberName(p) orelse continue;
        if (name.data == .computed_name and computedKeyStaticName(g, name) == null) return true;
    }
    return false;
}

fn spreadReadsUnknown(g: *Gate, e: *Node) bool {
    var current = e;
    while (true) {
        current = api.skipParens(current);
        if (current.data == .as_expr) {
            const asserted = tsTypeToHType(g, g.typeAt(current));
            if (asserted.* == .number or asserted.* == .string or asserted.* == .boolean) return false;
            current = current.data.as_expr.expr;
            continue;
        }
        return tsTypeToHType(g, g.typeAt(current)).* == .unknown;
    }
}

pub fn layoutContextualType(g: *Gate, n: *Node) ?*Type {
    const outer = api.outermostParen(n).parent orelse return null;
    return if (outer.data == .satisfies_expr) null else g.contextualType(n);
}

pub fn objectLiteralIsDynamic(g: *Gate, literal: *Node) bool {
    const own = g.typeAt(literal);
    if (api.isAnyFlag(own) or literalHasRuntimeComputedKey(g, literal)) return true;
    if (layoutContextualType(g, literal)) |contextual| {
        if (isDynamicShape(g, contextual)) return true;
    }
    if (isDynamicShape(g, own)) return true;
    for (literal.data.object_lit.props) |p| {
        if (p.data == .spread_assign and spreadReadsUnknown(g, p.data.spread_assign.expr)) return true;
    }
    return false;
}

pub fn isDefaultExportDeclaration(n: *const Node) bool {
    return n.mods.@"export" and n.mods.default;
}

pub fn declaredTypeOf(g: *Gate, declaration: *Node) ?*Type {
    if (declaration.data.class.name == null) {
        return if (api.isClassDeclaration(declaration) and isDefaultExportDeclaration(declaration)) g.typeAt(declaration) else null;
    }
    const sym = declaration.symbol() orelse return null;
    g.c.silent += 1;
    defer g.c.silent -= 1;
    return decls.declaredType(g.c, sym.resolve());
}

/// Root first, as in `types.ts`; the guard is against `class A extends A`.
/// `declaration` and its base classes, nearest first; a cycle stops at the first repeat.
pub fn lineage(g: *Gate, declaration: *Node) []*Node {
    var chain: std.ArrayList(*Node) = .empty;
    var current: ?*Node = declaration;
    while (current) |c| {
        if (std.mem.indexOfScalar(*Node, chain.items, c) != null) break;
        chain.append(g.a, c) catch oom();
        current = baseClassOf(g, c);
    }
    return chain.items;
}

/// `lineage` from the root base down to `declaration`.
pub fn ancestry(g: *Gate, declaration: *Node) []*Node {
    const chain = g.a.dupe(*Node, lineage(g, declaration)) catch oom();
    std.mem.reverse(*Node, chain);
    return chain;
}

fn extendsTypeNode(declaration: *const Node) ?*Node {
    for (declaration.data.class.heritage) |h| {
        const clause = h.data.heritage_clause;
        if (clause.tok == .kw_extends and clause.types.len > 0) return clause.types[0];
    }
    return null;
}

pub fn extendsExpression(declaration: *const Node) ?*Node {
    const t = extendsTypeNode(declaration) orelse return null;
    return t.data.expr_with_type_args.expr;
}

pub fn baseClassOf(g: *Gate, declaration: *Node) ?*Node {
    const expression = extendsExpression(declaration) orelse return null;
    if (api.valueDeclaration(g.symbolAt(expression))) |base| {
        if (api.isClassDeclaration(base)) return base;
    }
    if (api.isIdentifier(expression)) {
        return aliasedClassDeclaration(g, expression) orelse classExpressionTarget(g, expression) orelse innerClassExpression(g, expression);
    }
    return null;
}

pub fn heritageSubstitution(g: *Gate, leaf: *Node, chain: []*Node) std.AutoHashMapUnmanaged(*Node, NameMap) {
    var grounded: std.AutoHashMapUnmanaged(*Node, NameMap) = .empty;
    const leaf_index = std.mem.indexOfScalar(*Node, chain, leaf) orelse return grounded;
    var i = leaf_index;
    while (i > 0) : (i -= 1) {
        const child = chain[i];
        const parent = chain[i - 1];
        const parameters = parent.data.class.type_params.items;
        if (parameters.len == 0) continue;
        const args: []*Node = if (extendsTypeNode(child)) |x| x.data.expr_with_type_args.type_args.items else &.{};
        if (args.len != parameters.len) continue;
        const child_map = grounded.getPtr(child);
        var parent_map: NameMap = .empty;
        for (parameters, args) |parameter, arg| {
            const raw = tsTypeToHType(g, g.typeFromNode(arg));
            const value = if (child_map) |m|
                H.substituteHType(g.a, raw, Lookup{ .map = m }) catch oom()
            else
                raw;
            parent_map.put(g.a, api.text(parameter.data.type_param.name).?, value) catch oom();
        }
        grounded.put(g.a, parent, parent_map) catch oom();
    }
    return grounded;
}

pub fn heritageTuple(g: *Gate, base: *Node, leaf: *Node) ?[]*const HType {
    const parameters = base.data.class.type_params.items;
    if (parameters.len == 0) return null;
    const chain = ancestry(g, leaf);
    if (std.mem.indexOfScalar(*Node, chain, base) == null) return null;
    var map = heritageSubstitution(g, leaf, chain);
    const grounded = map.getPtr(base) orelse return null;
    const tuple = g.a.alloc(*const HType, parameters.len) catch oom();
    for (parameters, tuple) |parameter, *out| {
        out.* = grounded.get(api.text(parameter.data.type_param.name).?) orelse return null;
    }
    return tuple;
}

pub fn baseDescriptorName(g: *Gate, base: *Node, leaf: *Node) []const u8 {
    const name = if (api.isClassExpression(base))
        expressionClassName(base) orelse ""
    else if (base.data.class.name) |n| api.text(n).? else "";
    if (name.len == 0) return "";
    const tuple = heritageTuple(g, base, leaf) orelse return name;
    for (tuple) |t| if (H.hasTypeParam(t)) return name;
    return H.specializationName(g.a, name, tuple) catch oom();
}

/// A class declaration with a name, by the instance type. An anonymous default export has none.
pub fn classDeclarationOf(t: *Type) ?*Node {
    const declaration = api.valueDeclaration(api.typeSymbol(t)) orelse return null;
    return if (api.isClassDeclaration(declaration) and declaration.data.class.name != null) declaration else null;
}

pub fn isStaticMember(member: *const Node) bool {
    return member.mods.static;
}

pub fn hasAbstractModifier(member: *const Node) bool {
    return member.mods.abstract;
}

pub fn hirPropertyName(name: []const u8) []const u8 {
    return if (std.mem.startsWith(u8, name, iterator_method_name)) iterator_method_name else name;
}

pub fn privateSlotName(g: *Gate, owner: []const u8, raw: []const u8) []const u8 {
    return g.fmt("#{s}@{s}", .{ raw[1..], owner });
}

pub fn privateMethodName(g: *Gate, owner: []const u8, raw: []const u8) []const u8 {
    if (std.mem.startsWith(u8, raw, "get #") or std.mem.startsWith(u8, raw, "set #")) {
        return g.fmt("{s} {s}", .{ raw[0..3], privateSlotName(g, owner, raw[4..]) });
    }
    return if (std.mem.startsWith(u8, raw, "#")) privateSlotName(g, owner, raw) else raw;
}

fn privateOwnerName(p: *Prop, at: ?*Node, chain: []const *Node, ancestor: *Node) ?[]const u8 {
    if (at) |d| if (d.parent) |parent| if (api.isClassLike(parent)) {
        if (classDisplayName(parent)) |name| return name;
    };
    for (chain) |candidate| {
        for (api.propDeclarations(p)) |d| if (d.parent == candidate) return classDisplayName(candidate);
    }
    return classDisplayName(ancestor);
}

fn isSymbolIteratorAccess(e: *const Node) bool {
    if (e.data != .prop_access) return false;
    const x = e.data.prop_access;
    return !x.optional and api.identifierIs(x.expr, "Symbol") and api.identifierIs(x.name, "iterator");
}

pub fn symbolIteratorAccess(name: *const Node) ?*Node {
    if (name.data != .computed_name) return null;
    const e = name.data.computed_name.expr;
    return if (isSymbolIteratorAccess(e)) e else null;
}

/// `member.name`, of what can sit in a class body or an object literal.
pub fn instanceMethodName(g: *Gate, member: *const Node) ?[]const u8 {
    const name = api.declarationName(member) orelse return null;
    switch (name.data) {
        .identifier, .private_name, .string_lit, .numeric_lit => return api.text(name),
        .computed_name => {},
        else => return null,
    }
    if (symbolIteratorAccess(name) != null) return iterator_method_name;
    return computedKeyStaticName(g, name);
}

pub fn isGlobalSymbolIteratorName(g: *Gate, name: *Node) bool {
    const access = symbolIteratorAccess(name) orelse return false;
    return g.declaredOnlyInDeclarationFiles(g.symbolAt(access.data.prop_access.expr));
}

pub fn isSymbolIteratorKey(g: *Gate, arg: *Node) bool {
    return isSymbolIteratorAccess(arg) and g.declaredOnlyInDeclarationFiles(g.symbolAt(arg.data.prop_access.expr));
}

pub fn userIteratorMethod(t: *const HType) ?*const HField {
    if (t.* != .object) return null;
    for (t.object.methods) |*m| {
        if (!eql(m.name, iterator_method_name)) continue;
        if (m.type.* == .@"fn" and m.type.@"fn".ret.* == .iterator) return m;
        return null;
    }
    return null;
}

fn listOfDeclarator(d: *const Node) ?*Node {
    const list = d.parent orelse return null;
    return if (list.data == .var_list) list else null;
}

pub fn isSingleConstDeclarator(d: *const Node) bool {
    const list = listOfDeclarator(d) orelse return false;
    const x = list.data.var_list;
    return x.kind == .@"const" and x.decls.len == 1 and api.isIdentifier(d.data.var_decl.name);
}

fn writtenIdentifiers(g: *Gate, target: *Node, out: *std.ArrayList(*Node)) void {
    const inner = api.skipParens(target);
    switch (inner.data) {
        .identifier => out.append(g.a, inner) catch oom(),
        .array_lit => |x| for (x.elems) |e| writtenIdentifiers(g, e, out),
        .object_lit => |x| for (x.props) |p| switch (p.data) {
            .shorthand_assign => |s| out.append(g.a, s.name) catch oom(),
            .property_assign => |s| writtenIdentifiers(g, s.value, out),
            .spread_assign => |s| writtenIdentifiers(g, s.expr, out),
            else => {},
        },
        .spread_elem => |x| writtenIdentifiers(g, x.expr, out),
        .binary => |x| if (x.op == .assign) writtenIdentifiers(g, x.left, out),
        else => {},
    }
}

const SymbolWrite = struct { g: *Gate, symbol: *Symbol };

fn writesSymbol(s: SymbolWrite, n: *Node) ast_walk.Step {
    var targets: std.ArrayList(*Node) = .empty;
    const g = s.g;
    switch (n.data) {
        .binary => |x| if (api.expr.isAssignOp(x.op)) writtenIdentifiers(g, x.left, &targets),
        inline .prefix, .postfix => |x| if (x.op == .plus2 or x.op == .minus2) writtenIdentifiers(g, x.expr, &targets),
        inline .for_in, .for_of => |x| if (x.init.data != .var_list) writtenIdentifiers(g, x.init, &targets),
        else => {},
    }
    for (targets.items) |id| {
        const found = g.symbolAt(id) orelse continue;
        if (found == s.symbol or found.resolve() == s.symbol.resolve()) return .match;
    }
    return .descend;
}

fn isNeverWritten(g: *Gate, declaration: *Node) bool {
    if (g.never_written.get(declaration)) |cached| return cached;
    const symbol = g.symbolAt(declaration.data.var_decl.name) orelse return false;
    const file = g.fileOf(declaration);
    const never = file == null or !ast_walk.contains(file.?.root, SymbolWrite{ .g = g, .symbol = symbol }, writesSymbol);
    g.never_written.put(g.a, declaration, never) catch oom();
    return never;
}

pub fn isClassFormationDeclarator(g: *Gate, d: *Node) bool {
    const list = listOfDeclarator(d) orelse return false;
    const x = list.data.var_list;
    if (x.decls.len != 1 or !api.isIdentifier(d.data.var_decl.name)) return false;
    return x.kind == .@"const" or isNeverWritten(g, d);
}

fn declarationThroughAlias(g: *Gate, sym: *Symbol) ?*Node {
    if (api.isAlias(sym)) return api.valueDeclaration(g.aliased(sym));
    return api.valueDeclaration(sym);
}

pub fn aliasedClassDeclaration(g: *Gate, n: *Node) ?*Node {
    var seen: std.ArrayList(*Symbol) = .empty;
    var current: ?*Node = n;
    while (current) |cur| {
        const sym = g.symbolAt(cur) orelse return null;
        if (std.mem.indexOfScalar(*Symbol, seen.items, sym) != null) return null;
        seen.append(g.a, sym) catch oom();
        const declaration = declarationThroughAlias(g, sym) orelse return null;
        if (api.isClassDeclaration(declaration)) {
            return if (classDisplayName(declaration) != null) declaration else null;
        }
        if (declaration.data != .var_decl) return null;
        const x = declaration.data.var_decl;
        const init = x.init orelse return null;
        if (x.name == cur or !api.isIdentifier(init) or !isSingleConstDeclarator(declaration)) return null;
        current = init;
    }
    return null;
}

pub fn classExpressionTarget(g: *Gate, n: *Node) ?*Node {
    const sym = g.symbolAt(n) orelse return null;
    const declaration = declarationThroughAlias(g, sym) orelse return null;
    if (declaration.data != .var_decl) return null;
    const x = declaration.data.var_decl;
    const init = x.init orelse return null;
    if (x.name == n or !api.isClassExpression(init) or !isClassFormationDeclarator(g, declaration)) return null;
    return init;
}

pub fn innerClassExpression(g: *Gate, n: *Node) ?*Node {
    const declaration = api.valueDeclaration(g.symbolAt(n)) orelse return null;
    if (!api.isClassExpression(declaration)) return null;
    const name = declaration.data.class.name orelse return null;
    if (!eql(api.text(name).?, api.text(n) orelse "") or n == name) return null;
    var current = n.parent;
    while (current) |c| : (current = c.parent) {
        if (c == declaration) return declaration;
    }
    return null;
}

pub fn expressionClassName(e: *const Node) ?[]const u8 {
    if (e.data.class.name) |n| return api.text(n);
    const parent = e.parent orelse return null;
    if (parent.data != .var_decl) return null;
    const x = parent.data.var_decl;
    return if (api.isIdentifier(x.name) and x.init == e) api.text(x.name) else null;
}

pub fn classDisplayName(n: *const Node) ?[]const u8 {
    if (api.isClassExpression(n)) return expressionClassName(n);
    if (n.data.class.name) |name| return api.text(name);
    return if (isDefaultExportDeclaration(n)) default_export_binding else null;
}

fn isFunctionConstructorInstance(t: *Type) bool {
    const sym = (api.typeSymbol(t) orelse return false).resolve();
    if (sym.flags & F.class == 0) return false;
    if (sym.decls.len == 0) return false;
    for (sym.decls) |d| if (api.isClassLike(d)) return false;
    return true;
}

pub fn isFunctionValueCallee(g: *Gate, callee: *Node) bool {
    if (g.declaredOnlyInDeclarationFiles(g.symbolAt(callee))) return false;
    const t = g.typeAt(callee);
    if (classLikeOf(t) != null or g.declaredOnlyInDeclarationFiles(api.typeSymbol(t))) return false;
    const shape = tsTypeToHType(g, t);
    return shape.* == .@"fn" or shape.* == .unknown;
}

pub fn isFunctionValueMember(g: *Gate, receiver: *Node, name: []const u8) bool {
    if (eql(name, "length")) return false;
    const t = g.typeAt(receiver);
    if (classLikeOf(t) != null or tsTypeToHType(g, t).* != .@"fn") return false;
    if (g.declaredOnlyInDeclarationFiles(g.symbolAt(receiver))) return false;
    if (eql(name, "prototype") or eql(name, "name")) return true;
    const prop = g.property(t, name) orelse return true;
    return !g.declaredOnlyInDeclarationFiles(api.propSymbol(prop));
}

pub fn isUndeclaredMember(g: *Gate, receiver: *Node, name: []const u8) bool {
    const t = g.typeAt(receiver);
    const shape = tsTypeToHType(g, t);
    return shape.* == .object and shape.object.namespace != true and g.property(t, name) == null;
}

pub fn isUndeclaredMemberRead(g: *Gate, e: *Node) bool {
    if (e.data != .prop_access or e.data.prop_access.name.data == .private_name) return false;
    return isUndeclaredMember(g, e.data.prop_access.expr, api.text(e.data.prop_access.name).?);
}

pub fn isFunctionMemberRead(g: *Gate, e: *Node) bool {
    return e.data == .prop_access and isFunctionValueMember(g, e.data.prop_access.expr, api.text(e.data.prop_access.name).?);
}

pub fn classLikeOf(t: *Type) ?*Node {
    const declaration = api.valueDeclaration(api.typeSymbol(t)) orelse return null;
    return if (api.isClassLike(declaration)) declaration else null;
}

pub fn isClassAliasUse(g: *Gate, n: *Node) bool {
    if (aliasedClassDeclaration(g, n) == null) return false;
    const sym = g.symbolAt(n);
    const direct = if (sym != null and !api.isAlias(sym.?)) sym.?.resolve().value_decl else null;
    return direct == null or !api.isClassDeclaration(direct.?);
}

pub const StaticMember = struct { owner: *Node, member: *Node };

fn isMemberNamed(g: *Gate, m: *const Node, name: []const u8) bool {
    const member_name = api.declarationName(m) orelse return false;
    return switch (member_name.data) {
        .identifier, .private_name => eql(api.text(member_name).?, name),
        .computed_name => if (computedKeyStaticName(g, member_name)) |k| eql(k, name) else false,
        else => false,
    };
}

pub fn staticMemberOf(g: *Gate, access: *Node, want_method: ?bool) ?StaticMember {
    const x = access.data.prop_access;
    const name = api.text(x.name).?;
    if (x.expr.data == .this_expr) {
        const owner = staticThisClass(access) orelse return null;
        return staticMemberIn(g, owner, name, want_method);
    }
    if (x.expr.data == .super_expr) {
        const owner = staticSuperClass(g, access) orelse return null;
        return staticMemberIn(g, owner, name, want_method);
    }
    if (!api.isIdentifier(x.expr)) return null;
    const direct = api.valueDeclaration(g.symbolAt(x.expr));
    const declaration = if (direct != null and api.isClassDeclaration(direct.?))
        direct.?
    else
        classExpressionTarget(g, x.expr) orelse innerClassExpression(g, x.expr) orelse aliasedClassDeclaration(g, x.expr) orelse return null;
    return staticMemberIn(g, declaration, name, want_method);
}

fn staticMemberIn(g: *Gate, declaration: *Node, name: []const u8, want_method: ?bool) ?StaticMember {
    for (lineage(g, declaration)) |current| {
        for (current.data.class.members) |m| {
            if (!isStaticMember(m) or !isMemberNamed(g, m, name)) continue;
            if (want_method == null or api.isMethodDeclaration(m) == want_method.?) return .{ .owner = current, .member = m };
            return null;
        }
    }
    return null;
}

pub fn staticThisClass(access: *const Node) ?*Node {
    var cur = access.parent;
    while (cur) |n| : (cur = n.parent) {
        switch (n.data) {
            .class => return n,
            .property_decl => if (!isStaticMember(n)) return null,
            .func => |x| switch (x.kind) {
                .ctor, .method, .getter, .setter => if (!isStaticMember(n)) return null,
                .decl, .expr => return null,
                else => {},
            },
            else => {},
        }
    }
    return null;
}

pub fn staticSuperClass(g: *Gate, access: *const Node) ?*Node {
    const self = staticThisClass(access) orelse return null;
    return baseClassOf(g, self);
}

pub fn methodDeclaringClass(g: *Gate, declaration: *Node, name: []const u8) ?*Node {
    if (H.accessorProperty(name)) |prop| {
        const found = accessorDeclaringClass(g, declaration, prop) orelse return null;
        return found.owner;
    }
    for (lineage(g, declaration)) |current| {
        for (current.data.class.members) |m| {
            if (!api.isMethodDeclaration(m)) continue;
            if (instanceMethodName(g, m)) |k| if (eql(k, name)) return current;
        }
    }
    return null;
}

pub const AccessorPair = struct { owner: *Node, get: bool, set: bool };

pub fn accessorDeclaringClass(g: *Gate, declaration: *Node, name: []const u8) ?AccessorPair {
    for (lineage(g, declaration)) |current| {
        var get = false;
        var set = false;
        for (current.data.class.members) |m| {
            if (!isMemberNamed(g, m, name)) continue;
            get = get or api.isGetAccessor(m);
            set = set or api.isSetAccessor(m);
        }
        if (get or set) return .{ .owner = current, .get = get, .set = set };
    }
    return null;
}

fn isAnyKeyword(n: *const Node) bool {
    return n.data == .kw_type and n.data.kw_type == .any;
}

fn annotationSite(n: *const Node) enum { none, bare, annotated } {
    const annotation: ?*Node = switch (n.data) {
        .var_decl => |x| blk: {
            const list = n.parent orelse break :blk api.ast.writtenType(n, x.type);
            if (list.data == .var_list and list.parent != null and list.parent.?.data == .for_of) return .none;
            break :blk api.ast.writtenType(n, x.type);
        },
        .param => |x| api.ast.writtenType(n, x.type),
        .property_decl => |x| api.ast.writtenType(n, x.type),
        .property_sig => |x| x.type,
        .func => |x| switch (x.kind) {
            .decl, .method, .arrow, .expr => api.ast.writtenType(n, x.ret),
            else => return .none,
        },
        else => return .none,
    };
    return if (annotation == null) .bare else .annotated;
}

fn initializerOf(n: *const Node) ?*Node {
    return node_field.of(?*Node, n, .{ .{ .var_decl, "init" }, .{ .param, "init" }, .{ .property_decl, "init" } });
}

fn initializerIsExplicitAny(n: *const Node) bool {
    const init = initializerOf(n) orelse return false;
    return switch (init.data) {
        .as_expr => |x| isAnyKeyword(x.type),
        .type_assertion => |x| isAnyKeyword(x.type),
        else => false,
    };
}

pub fn isImplicitAny(g: *Gate, n: *Node) bool {
    if (annotationSite(n) != .bare or initializerIsExplicitAny(n)) return false;
    if (n.data == .var_decl and !api.isIdentifier(n.data.var_decl.name)) {
        if (n.parent != null and n.parent.?.data == .catch_clause) return false;
        if (n.data.var_decl.init) |init| return api.isAnyFlag(g.typeAt(init));
    }
    return api.isAnyFlag(g.typeAt(n));
}

pub fn hasExplicitAny(n: *const Node) bool {
    return switch (n.data) {
        .var_decl => |x| x.type != null and isAnyKeyword(x.type.?),
        .param => |x| x.type != null and isAnyKeyword(x.type.?),
        .func => |x| (x.kind == .decl or x.kind == .arrow or x.kind == .expr) and x.ret != null and isAnyKeyword(x.ret.?),
        .as_expr => |x| isAnyKeyword(x.type),
        .type_assertion => |x| isAnyKeyword(x.type),
        else => false,
    };
}
