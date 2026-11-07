//! Member and element reads, `this`, for-of, and the receiver predicates they share with calls.

const std = @import("std");
const api = @import("gate_api.zig");
const types = @import("gate_types.zig");
const core = @import("gate.zig");
const call_ = @import("gate_call.zig");
const class_ = @import("gate_class.zig");
const globals = @import("gate_globals.zig");
const N = @import("../hir/nodes.zig");
const H = @import("../hir/types.zig");

const Gate = api.Gate;
const Node = api.Node;
const Result = api.Result;
const Type = api.Type;
const accept = api.accept;
const eql = api.eql;
const oom = api.oom;

fn hir(g: *Gate, n: *Node) *const H.HType {
    return types.tsTypeToHType(g, g.typeAt(n));
}

pub fn isReceiverMember(n: *const Node) bool {
    return api.isConstructor(n) or api.isMethodDeclaration(n) or api.isGetAccessor(n) or api.isSetAccessor(n) or n.data == .property_decl;
}

pub fn gateThis(g: *Gate, node: *Node) Result {
    var cursor = node.parent;
    while (cursor) |n| : (cursor = n.parent) {
        if (isReceiverMember(n)) {
            if (!types.isStaticMember(n)) return accept;
            if (n.data == .property_decl and isStaticThisMemberUse(g, node)) return accept;
            return g.notYet("this in a static class member is not yet supported", 5);
        }
        if (n.data == .static_block) {
            return if (isStaticThisMemberUse(g, node)) accept else g.notYet("this in a static initialization block is not yet supported", 5);
        }
        if (api.isFunctionDeclaration(n) or api.isFunctionExpression(n)) return accept;
    }
    return g.notYet("this outside a method or function is not yet supported", 5);
}

fn isStaticThisMemberUse(g: *Gate, node: *Node) bool {
    const parent = node.parent orelse return false;
    return parent.data == .prop_access and parent.data.prop_access.expr == node and types.staticMemberOf(g, parent, null) != null;
}

pub fn typeParameterConstraint(g: *Gate, receiver: *Type) ?*Type {
    if (receiver.data != .param) return null;
    const symbol = api.typeSymbol(receiver) orelse return null;
    const declarations = symbol.decls;
    if (declarations.len == 0) return null;
    for (declarations) |d| if (d.data != .type_param) return null;
    const constraint = declarations[0].data.type_param.constraint orelse return null;
    return g.typeFromNode(constraint);
}

pub const Family = enum { string, array, date, regexp };

pub fn constraintMatches(g: *Gate, expression: *Node, family: Family) bool {
    const constraint = typeParameterConstraint(g, g.typeAt(expression)) orelse return false;
    return switch (family) {
        .string => api.isStringLike(constraint),
        .array => g.isArrayType(constraint),
        .date => types.tsTypeToHType(g, constraint).* == .date,
        .regexp => types.tsTypeToHType(g, constraint).* == .regexp,
    };
}

pub fn constraintCollection(g: *Gate, expression: *Node) ?call_.Collection {
    const constraint = typeParameterConstraint(g, g.typeAt(expression)) orelse return null;
    return switch (types.tsTypeToHType(g, constraint).*) {
        .map => .map,
        .set => .set,
        else => null,
    };
}

pub const NameSet = std.StringHashMapUnmanaged(void);

pub fn enclosingTypeParameterNames(g: *Gate, node: *Node) NameSet {
    var names: NameSet = .empty;
    var cursor = node.parent;
    while (cursor) |current| : (cursor = current.parent) {
        const parameters = if (api.isFunctionDeclaration(current) or api.isFunctionExpression(current) or api.isArrowFunction(current) or api.isMethodDeclaration(current))
            current.data.func.type_params.items
        else if (api.isClassDeclaration(current))
            current.data.class.type_params.items
        else
            continue;
        for (parameters) |parameter| {
            names.put(g.a, api.text(parameter.data.type_param.name) orelse "", {}) catch oom();
        }
    }
    return names;
}

pub fn mentionsUnboundParameter(g: *Gate, t: *const H.HType, bound: NameSet) bool {
    return switch (t.*) {
        .type_param => |p| !bound.contains(p.name),
        .array => |a| mentionsUnboundParameter(g, a.element, bound),
        .set => |s| mentionsUnboundParameter(g, s.element, bound),
        .iterator => |i| mentionsUnboundParameter(g, i.element, bound),
        .map => |m| mentionsUnboundParameter(g, m.key, bound) or mentionsUnboundParameter(g, m.value, bound),
        .@"fn" => |f| blk: {
            for (f.params) |p| if (mentionsUnboundParameter(g, p, bound)) break :blk true;
            break :blk mentionsUnboundParameter(g, f.ret, bound);
        },
        .object => |o| blk: {
            for (o.fields) |f| if (mentionsUnboundParameter(g, f.type, bound)) break :blk true;
            for (o.methods) |m| if (mentionsUnboundParameter(g, m.type, bound)) break :blk true;
            break :blk false;
        },
        else => false,
    };
}

pub fn constraintDeclaration(g: *Gate, receiver: *Type) ?*Node {
    const constraint = typeParameterConstraint(g, receiver) orelse return null;
    const declaration = types.classDeclarationOf(constraint) orelse return null;
    return if (declaration.data.class.type_params.items.len > 0) null else declaration;
}

const SuperScan = struct {
    g: *Gate,
    found: bool = false,

    fn visit(s: *SuperScan, node: *Node) void {
        if (s.found or api.isClassLike(node)) return;
        if (node.data == .super_expr) {
            const parent = node.parent;
            const resolved = parent != null and parent.?.data == .prop_access and parent.?.data.prop_access.expr == node and types.staticMemberOf(s.g, parent.?, null) != null;
            if (!resolved) s.found = true;
            return;
        }
        api.ast.forEachChild(node, s, visit);
    }
};

pub fn staticBlockUsesSuper(g: *Gate, block: *Node) bool {
    var scan = SuperScan{ .g = g };
    SuperScan.visit(&scan, block.data.static_block.body);
    return scan.found;
}

fn superValueHasReceiver(access: *Node) bool {
    var cursor = access.parent;
    while (cursor) |n| : (cursor = n.parent) {
        if (isReceiverMember(n)) return !types.isStaticMember(n);
        if (n.data == .static_block) return false;
        if (api.isFunctionDeclaration(n) or api.isFunctionExpression(n) or api.isClassLike(n)) return false;
    }
    return false;
}

fn gateSymbolMember(g: *Gate, access: *Node) Result {
    const parent = access.parent orelse return core.symbolNotYet(g);
    if (parent.data == .elem_access and parent.data.elem_access.index == access and
        types.isSymbolIteratorKey(g, access) and call_.acceptsSymbolKeyBase(g, parent.data.elem_access.expr)) return accept;
    if (parent.data == .computed_name and types.isGlobalSymbolIteratorName(g, parent)) return accept;
    return core.symbolNotYet(g);
}

fn gateSuperMember(g: *Gate, access: *Node) Result {
    const x = access.data.prop_access;
    if (types.staticMemberOf(g, access, null) != null) return accept;
    const base = types.classLikeOf(g.typeAt(x.expr));
    const method = if (base != null and api.isIdentifier(x.name)) types.methodDeclaringClass(g, base.?, api.text(x.name) orelse "") else null;
    if (api.isCallee(access)) {
        return if (method != null) accept else g.notYet("super on anything but an inherited method is not yet supported", 5);
    }
    if (method != null and superValueHasReceiver(access)) return accept;
    return g.notYet("super as a value is not yet supported", 5);
}

pub fn gateMemberAccess(g: *Gate, access: *Node) Result {
    const x = access.data.prop_access;
    const receiver = x.expr;
    const name = api.text(x.name) orelse "";
    const parent = access.parent orelse return accept;
    const is_callee = api.isCallee(access);
    if (api.identifierIs(receiver, "Symbol")) return gateSymbolMember(g, access);
    if (receiver.data == .super_expr) return gateSuperMember(g, access);
    if (globals.isGlobalMath(g, receiver)) {
        if (globals.isMathConstant(name)) return accept;
        if (globals.isMathMethod(name)) return globals.calleeOnlyMember(g, access, "a Math method");
        return g.notYet(g.fmt("Math.{s} is not yet supported", .{name}), 5);
    }
    if (globals.isGlobalObject(g, receiver)) {
        if (globals.objectStatic(name) != null) return globals.calleeOnlyMember(g, access, "an Object method");
        return g.notYet(g.fmt("Object.{s} is not yet supported", .{name}), globals.objectStaticOwner(name) orelse 5);
    }
    if (globals.isGlobalDate(g, receiver)) {
        if (std.meta.stringToEnum(N.DateStatic, name) != null) return globals.calleeOnlyMember(g, access, "a Date method");
        return core.dateNotYet(g, g.fmt("Date.{s}", .{name}), 5);
    }
    if (hir(g, receiver).* == .number) {
        if (std.meta.stringToEnum(N.NumberOperation, name) != null) return globals.calleeOnlyMember(g, access, "a Number method");
        return g.notYet(g.fmt("Number.prototype.{s} is not yet supported", .{name}), 5);
    }
    if (globals.isDateReceiver(g, receiver)) {
        if (std.meta.stringToEnum(N.DateOperation, name) != null) return globals.calleeOnlyMember(g, access, "a Date method");
        return core.dateNotYet(g, g.fmt("Date.prototype.{s}", .{name}), null);
    }
    if (globals.isGlobalPromise(g, receiver)) {
        if (globals.promiseStatic(name) != null) return globals.calleeOnlyMember(g, access, "a Promise method");
        return g.notYet(g.fmt("Promise.{s} is not yet supported", .{name}), 5);
    }
    if (hir(g, receiver).* == .promise) {
        if (eql(name, "then") or eql(name, "catch") or eql(name, "finally")) {
            return globals.calleeOnlyMember(g, access, g.fmt("Promise.prototype.{s}", .{name}));
        }
        return api.notYetCode("STA1216", g.fmt("Promise.prototype.{s} is not yet supported: use an async function, whose await and return do the same work", .{name}), 5);
    }
    if (globals.isGlobalJson(g, receiver)) {
        if (eql(name, "stringify") or eql(name, "parse")) return globals.calleeOnlyMember(g, access, g.fmt("JSON.{s}", .{name}));
        return g.notYet(g.fmt("JSON.{s} is not yet supported", .{name}), 5);
    }
    if (globals.isGlobalString(g, receiver)) {
        if (eql(name, "fromCharCode")) return globals.calleeOnlyMember(g, access, g.fmt("String.{s}", .{name}));
        return g.notYet(g.fmt("String.{s} is not yet supported", .{name}), 5);
    }
    if (globals.numberConstant(g, access) != null) return accept;
    for (globals.callee_only_statics) |entry| {
        if (globals.isGlobalNamed(g, receiver, entry.base)) {
            for (entry.members) |m| {
                if (eql(m, name)) return globals.calleeOnlyMember(g, access, g.fmt("{s}.{s}", .{ entry.base, name }));
            }
            return g.notYet(g.fmt("{s}.{s} is not yet supported", .{ entry.base, name }), 5);
        }
    }
    const on_string = isStringReceiver(g, receiver);
    if (on_string and !eql(name, "length") and parent.data != .call) {
        return if (std.meta.stringToEnum(N.StringOpName, name) != null)
            g.notYet("using a string method as a value is not yet supported", 5)
        else
            g.notYet(g.fmt("String.prototype.{s} is not yet supported", .{name}), 5);
    }
    if (on_string and is_callee) return accept;
    const on_array = isArrayReceiver(g, receiver);
    if (on_array and !eql(name, "length") and !is_callee) {
        const known = std.meta.stringToEnum(N.ArrayOpName, name) != null;
        if (known and globals.isSelfBoundCallApply(g, access)) return accept;
        return if (known)
            g.notYet("using an array method as a value is not yet supported", 5)
        else
            g.notYet(g.fmt("Array.prototype.{s} is not yet supported", .{name}), 5);
    }
    if (on_array and is_callee) return accept;
    if (globals.typedConstructorOf(g, receiver)) |typed| {
        if (eql(name, "isView") and globals.isGlobalNamed(g, receiver, "ArrayBuffer")) {
            return globals.calleeOnlyMember(g, access, "ArrayBuffer.isView");
        }
        return g.notYet(g.fmt("{s}.{s} is not yet supported", .{ N.typedClassName(typed), name }), 11);
    }
    // A member a `Uint8Array` subclass declares itself is the class's, vetted by the class paths
    // below (plan/T11.6a); only what it inherits from the lib is a typed-array member.
    if (if (globals.isUserClassMember(g, access)) null else globals.typedReceiverKind(g, receiver)) |typed| {
        const qualified = g.fmt("{s}.prototype.{s}", .{ N.typedClassName(typed), name });
        const op = N.typedMember(typed, name) orelse return g.notYet(g.fmt("{s} is not yet supported", .{qualified}), 11);
        return if (N.TYPED_OPS.get(op).form != .call or is_callee)
            accept
        else
            g.notYet(g.fmt("using {s} as a value is not yet supported", .{qualified}), 11);
    }
    if (isRegExpReceiver(g, receiver)) {
        if (is_callee or std.meta.stringToEnum(N.RegExpField, name) != null) return accept;
        return api.notYetCode("STA1211", g.fmt("RegExp.prototype.{s} is not yet supported; planned for Phase 8", .{name}), 8);
    }
    if (types.staticMemberOf(g, access, null) != null) return accept;
    if (core.classConstructorTypeOf(g, g.typeAt(receiver))) {
        if (eql(name, "prototype")) return g.notYet("the prototype surface is not yet supported", 8);
        if (eql(name, "name")) return accept;
        return g.notYet("a member read through a class object is not yet supported", 5);
    }
    if (hir(g, receiver).* == .iterator) {
        return if (is_callee and (eql(name, "next") or eql(name, "return") or eql(name, "throw")))
            accept
        else
            g.notYet(g.fmt("Iterator.{s} as a value is not yet supported", .{name}), 5);
    }
    if (call_.collectionOf(g, receiver) orelse constraintCollection(g, receiver)) |collection| {
        if (eql(name, "size") or is_callee) return accept;
        return g.notYet(g.fmt("{s}.{s} as a value is not yet supported", .{ call_.collectionName(collection), name }), 5);
    }
    const receiver_type = g.typeAt(receiver);
    const declaration = types.classLikeOf(receiver_type) orelse constraintDeclaration(g, receiver_type) orelse {
        return gateShapeMember(g, access, name, is_callee);
    };
    if (api.isIdentifier(receiver) and api.valueDeclaration(g.symbolAt(receiver)) == declaration) {
        return g.notYet("using a class as a value is not yet supported", 5);
    }
    if (types.accessorDeclaringClass(g, declaration, name) != null) return accept;
    if (api.isIdentifier(x.name) and class_.classHasIndexSignature(g, declaration) and g.property(receiver_type, name) == null) {
        return g.notYet("a dynamic key on a class with an index signature is not yet supported", 8);
    }
    return accept;
}

fn isMethodLike(d: *const Node) bool {
    return api.isMethodDeclaration(d) or (d.data == .func and d.data.func.kind == .method_sig);
}

fn gateShapeMember(g: *Gate, access: *Node, name: []const u8, is_callee: bool) Result {
    const x = access.data.prop_access;
    const receiver = x.expr;
    const constraint = typeParameterConstraint(g, g.typeAt(receiver));
    if (constraint) |bound_type| {
        if (g.property(bound_type, name)) |prop| {
            var is_method = false;
            for (api.propDeclarations(prop)) |d| {
                if (isMethodLike(d)) is_method = true;
            }
            const bound = types.classDeclarationOf(bound_type);
            if (is_method and bound != null and bound.?.data.class.type_params.items.len > 0) {
                return g.notYet("a method call on an instance of a generic class with undetermined type arguments is not yet supported", 5);
            }
            if (!is_method or is_callee) return accept;
        }
    }
    if (isMatchReceiver(g, receiver)) {
        return if (std.meta.stringToEnum(N.MatchField, name) != null)
            accept
        else
            g.notYet(g.fmt("{s} on a RegExp match is not yet supported", .{name}), 5);
    }
    const shape = hir(g, receiver);
    if (call_.readsAsUnknown(g, receiver, shape)) return accept;
    if (types.isDynamicShape(g, g.typeAt(receiver))) {
        return if (is_callee) g.notYet("calling a method through a dynamic shape is not yet supported", 5) else accept;
    }
    if (shape.* == .object) {
        for (shape.object.fields) |f| if (eql(f.name, name)) return accept;
        for (shape.object.methods) |m| if (eql(m.name, name)) return globals.calleeOnlyMember(g, access, "a method");
        if (g.mode == .js and types.isUndeclaredMemberRead(g, access)) return accept;
        return g.notYet("a property that is not a field of the shape is not yet supported", 5);
    }
    if (types.isFunctionValueMember(g, receiver, name)) return call_.functionMemberResult(g);
    if ((eql(name, "call") or eql(name, "apply")) and is_callee and globals.isPlainFunctionValue(g, receiver)) return accept;
    return g.notYet("property access is not yet supported", 5);
}

pub fn gateElementAccess(g: *Gate, access: *Node) Result {
    if (call_.optionalChainElementReceiver(g, access)) |chained| return chained;
    const x = access.data.elem_access;
    const receiver = g.typeAt(x.expr);
    if (g.isArrayType(receiver) or isMatchReceiver(g, x.expr)) return accept;
    const shape = types.tsTypeToHType(g, receiver);
    const is_object = shape.* == .object;
    if (shape.* == .uint8array) {
        return if (api.isNumberLike(g.typeAt(x.index))) accept else g.notYet("a non-numeric key on a Uint8Array is not yet supported", 11);
    }
    if (typeParameterConstraint(g, receiver)) |constraint| {
        if (g.isArrayType(constraint)) return accept;
    }
    if (types.isSymbolIteratorKey(g, x.index)) {
        if (types.userIteratorMethod(shape) != null) return accept;
        if (shape.* == .unknown) return g.notYet("resolving '[Symbol.iterator]' on this receiver needs runtime GetIterator dispatch", 8);
    }
    const key = types.elementStaticKey(g, x.index);
    if (is_object and key != null) {
        const k = key.?;
        for (shape.object.fields) |f| if (eql(f.name, k)) return accept;
        for (shape.object.methods) |m| if (eql(m.name, k)) return globals.calleeOnlyMember(g, access, "a method");
        const getter = H.accessorName(g.a, .get, k) catch oom();
        const setter = H.accessorName(g.a, .set, k) catch oom();
        for (shape.object.methods) |m| {
            if (eql(m.name, getter) or eql(m.name, setter)) return accept;
        }
        if (g.mode == .js and shape.object.namespace != true) return accept;
        return g.notYet("index access on a non-array is not yet supported", 5);
    }
    if (is_object and key == null) {
        const index_type = g.typeAt(x.index);
        if (api.isObjectFlag(index_type) or index_type.data == .nonprim) return accept;
    }
    if (g.mode == .js and is_object and shape.object.namespace != true and key == null) return accept;
    return if (shape.* == .unknown or shape.* == .string or types.isDynamicShape(g, receiver))
        accept
    else
        g.notYet("index access on a non-array is not yet supported", 5);
}

pub fn gateForOf(g: *Gate, statement: *Node) Result {
    const x = statement.data.for_of;
    if (x.is_await) return core.generatorNotYet(g);
    const iterable = g.typeAt(x.expr);
    const constraint = typeParameterConstraint(g, iterable);
    const target = constraint orelse iterable;
    const shape = types.tsTypeToHType(g, target);
    const known = globals.isArrayOrTuple(g, target) or api.isStringLike(target) or shape.* == .map or shape.* == .set or
        shape.* == .iterator or shape.* == .uint8array or types.userIteratorMethod(shape) != null;
    if (!known and g.mode != .js) {
        for (g.properties(target)) |p| {
            if (eql(types.hirPropertyName(p.name), types.iterator_method_name)) {
                return g.notYet("for-of over a user iterable is not yet supported", 5);
            }
        }
    }
    const initializer = x.init;
    if (api.isIdentifier(initializer)) return accept;
    if (initializer.data != .var_list) return g.notYet("for-of over a member or pattern target is not yet supported", 5);
    const declarations = initializer.data.var_list.decls;
    if (declarations.len == 0 or !api.isIdentifier(declarations[0].data.var_decl.name)) {
        return g.notYet("destructuring in a for-of binding is not yet supported", 6);
    }
    return accept;
}

pub fn isStringReceiver(g: *Gate, expression: *Node) bool {
    return api.isStringLike(g.typeAt(expression));
}

pub fn isArrayReceiver(g: *Gate, expression: *Node) bool {
    return g.isArrayType(g.typeAt(expression));
}

pub fn isRegExpReceiver(g: *Gate, expression: *Node) bool {
    return hir(g, expression).* == .regexp;
}

fn isDeclaredBuiltin(g: *Gate, expression: *Node, names: []const []const u8) bool {
    const symbol = api.typeSymbol(g.typeAt(expression)) orelse return false;
    const name = api.symbolName(symbol) orelse return false;
    for (names) |candidate| {
        if (eql(name, candidate)) return g.declaredOnlyInDeclarationFiles(symbol);
    }
    return false;
}

pub fn isMatchReceiver(g: *Gate, expression: *Node) bool {
    return isDeclaredBuiltin(g, expression, &.{ "RegExpExecArray", "RegExpMatchArray" });
}

pub fn isGeneratorReceiver(g: *Gate, expression: *Node) bool {
    return isDeclaredBuiltin(g, expression, &.{"Generator"});
}

pub fn isVarDeclarationList(list: *const Node) bool {
    // `using` carries neither the let nor the const flag in TypeScript, so it reads like `var` here.
    return list.data.var_list.kind == .@"var" or list.data.var_list.kind == .using;
}

/// The receiver's type when the access reads `.length`.
fn lengthReceiver(g: *Gate, access: *Node) ?*Type {
    const x = access.data.prop_access;
    return if (api.identifierIs(x.name, "length")) g.typeAt(x.expr) else null;
}

pub fn isArrayLength(g: *Gate, access: *Node) bool {
    return g.isArrayType(lengthReceiver(g, access) orelse return false);
}

pub fn isStringLength(g: *Gate, access: *Node) bool {
    return api.isStringLike(lengthReceiver(g, access) orelse return false);
}

pub fn isFunctionLength(g: *Gate, access: *Node) bool {
    return g.callSignatures(lengthReceiver(g, access) orelse return false).len > 0;
}
