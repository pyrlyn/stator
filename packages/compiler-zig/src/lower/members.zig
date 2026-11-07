//! Reading the layout of a receiver: which class declares a member, which slot it has, and whether
//! the call on it dispatches. A generic receiver answers through its specialization's name.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Scope = c.Scope;
const Expression = c.Expression;
const Statement = c.Statement;
const HType = c.HType;
const Span = c.Span;
const E = c.E;
const H = c.H;
const N = c.N;
const api = c.api;
const gt = c.gt;
const gate = c.gate;
const gate_ops = @import("../frontend/gate_ops.zig");
const gate_globals = @import("../frontend/gate_globals.zig");
const gate_member = @import("../frontend/gate_member.zig");
const expressions = @import("expressions.zig");
const assign = @import("assign.zig");
const program = @import("program.zig");
const module_names = @import("module_names.zig");
const generics = @import("../frontend/generics.zig");
const specialize = @import("specialize.zig");
const ast_walk = @import("../support/ast_walk.zig");
const RECEIVER = c.captures.RECEIVER_NAME;

pub fn propertyText(node: *const Node) []const u8 {
    return api.text(node.data.prop_access.name) orelse "";
}

pub fn staticName(l: *Lower, class_name: []const u8, member: []const u8) []const u8 {
    return l.concat(&.{ class_name, ".", member });
}

pub fn hirClassName(l: *Lower, declaration: *Node) []const u8 {
    return l.hirNameOf(declaration) orelse gt.classDisplayName(declaration) orelse "";
}

pub fn classObjectOwner(l: *Lower, receiver: *Node) ?*Node {
    if (receiver.data != .identifier) return null;
    return gt.aliasedClassDeclaration(l.g, receiver) orelse gt.classExpressionTarget(l.g, receiver) orelse gt.innerClassExpression(l.g, receiver);
}

pub const PrivateUse = struct { owner: *Node, property: []const u8 };

pub fn privateUse(l: *Lower, name: *Node) ?PrivateUse {
    const owner = gate_ops.brandDeclaringClass(name) orelse return null;
    const owner_name = gt.classDisplayName(owner) orelse return null;
    return .{ .owner = owner, .property = gt.privateSlotName(l.g, owner_name, name.data.private_name) };
}

fn classMembers(owner: *const Node) []const *Node {
    return owner.data.class.members;
}

fn isPrivateNamed(member: *const Node, raw: []const u8) bool {
    const name = api.declarationName(member) orelse return false;
    return name.data == .private_name and c.eql(name.data.private_name, raw);
}

pub const Halves = struct { get: bool = false, set: bool = false };

pub fn privateAccessorHalves(owner: *const Node, raw: []const u8) Halves {
    var out: Halves = .{};
    for (classMembers(owner)) |member| {
        if (!isPrivateNamed(member, raw)) continue;
        if (api.isGetAccessor(member)) out.get = true;
        if (api.isSetAccessor(member)) out.set = true;
    }
    return out;
}

fn privateIsAccessor(owner: *const Node, raw: []const u8) bool {
    for (classMembers(owner)) |m| {
        if (isPrivateNamed(m, raw) and isAccessorMember(m)) return true;
    }
    return false;
}

pub fn privateWriteIsAccessor(l: *Lower, target: *Node) bool {
    if (target.data != .prop_access or target.data.prop_access.name.data != .private_name) return false;
    const name = target.data.prop_access.name;
    const p = privateUse(l, name) orelse return false;
    return privateIsAccessor(p.owner, name.data.private_name);
}

pub fn privateOwnerMember(owner: *const Node, raw: []const u8) ?*Node {
    for (classMembers(owner)) |m| if (isPrivateNamed(m, raw)) return m;
    return null;
}

pub fn isAccessorMember(member: *const Node) bool {
    return api.isGetAccessor(member) or api.isSetAccessor(member);
}

pub fn receiverTypeAt(l: *Lower, obj: *Node, b: *Scope) *const HType {
    if (obj.data == .prop_access) {
        const x = obj.data.prop_access;
        const name = propertyText(obj);
        const folds = (gate_globals.isGlobalMath(l.g, x.expr) and gate_globals.isMathConstant(name)) or gate_globals.numberConstant(l.g, obj) != null;
        if (!folds and (targetIsDynamic(l, x.expr, b) or gt.isFunctionValueMember(l.g, x.expr, name) or gt.isUndeclaredMemberRead(l.g, obj))) return c.hUnknown(false);
    }
    return expressions.typeAt(l, obj, b);
}

pub fn targetIsDynamic(l: *Lower, target: *Node, b: *Scope) bool {
    if (target.data == .this_expr) {
        const receiver = b.get(RECEIVER) orelse return false;
        return receiver.* == .unknown;
    }
    return gt.isFunctionMemberRead(l.g, target) or gt.isUndeclaredMemberRead(l.g, target) or
        gt.isDynamicShape(l.g, l.g.typeAt(target)) or expressions.typeAt(l, target, b).* == .unknown;
}

/// Resolved against `classLayoutOf`, so a `Uint8Array` subclass's view answers its class's slots.
pub fn methodSlot(t: *const HType, name: []const u8) i32 {
    const layout = H.classLayoutOf(t) orelse return -1;
    for (layout.methods, 0..) |m, i| if (c.eql(m.name, name)) return @intCast(i);
    return -1;
}

pub fn declaresMember(l: *Lower, t: *const HType, key: []const u8) bool {
    if (t.* != .object) return false;
    for (t.object.fields) |f| if (c.eql(f.name, key)) return true;
    return methodSlot(t, key) >= 0 or methodSlot(t, l.accessorName(.get, key)) >= 0 or methodSlot(t, l.accessorName(.set, key)) >= 0;
}

pub fn slotOf(l: *Lower, target: Expression, field: []const u8, at: *const Node) E!i32 {
    const t = target.getType();
    const slot: ?usize = if (t.* == .object) H.fieldSlot(&t.object, field) else null;
    return if (slot) |index| @intCast(index) else l.internal(at, "STA4060", l.fmt("no field '{s}' on {s}", .{ field, l.hTypeName(t) }));
}

pub fn receiverIdentifier(l: *Lower, node: *const Node, b: *Scope) E!Expression {
    const binding = b.get(RECEIVER) orelse return l.internal(node, "STA4061", "this with no receiver in scope");
    return l.ident(binding, l.span(node), RECEIVER);
}

pub fn isClassInstance(l: *Lower, node: *Node, b: *Scope) bool {
    if (node.data == .identifier and classObjectOwner(l, node) != null) return false;
    return H.classLayoutOf(expressions.typeAt(l, node, b)) != null;
}

// ---- which class a generic receiver names

pub fn classTupleFor(l: *Lower, declaration: *Node, receiver_type: *c.Type, b: *Scope) ?[]const *const HType {
    const parameters = specialize.typeParameters(declaration);
    if (parameters.len == 0) return &.{};
    const reference = generics.classReferenceTuple(l.g, declaration, receiver_type);
    const leaf = gt.classDeclarationOf(receiver_type);
    const heritage: ?[]const *const HType = if (leaf == null or leaf.? == declaration) null else gt.heritageTuple(l.g, declaration, leaf.?);
    const lookup: expressions.BoundParameters = .{ .b = b, .l = l };
    const tuple = l.a.alloc(*const HType, parameters.len) catch c.oom();
    for (parameters, tuple, 0..) |parameter, *slot, i| {
        const name = api.text(parameter.data.type_param.name);
        const argument: ?*const HType = if (reference != null and i < reference.?.len) reference.?[i] else if (heritage != null and i < heritage.?.len) heritage.?[i] else null;
        const from_reference: ?*const HType = if (argument) |x| H.substituteHType(l.a, x, lookup) catch c.oom() else null;
        const element = from_reference orelse (if (name) |n| b.get(specialize.typeParameterKey(l, n)) else null) orelse return null;
        if (H.hasTypeParam(element)) return null;
        slot.* = element;
    }
    return tuple;
}

pub fn mangleClassName(l: *Lower, owner: *Node, receiver: *Node, b: ?*Scope) ?[]const u8 {
    if (owner.data.class.is_expr) return l.hirNameOf(owner) orelse gt.expressionClassName(owner);
    const name = gt.classDisplayName(owner) orelse return null;
    if (name.len == 0) return null;
    if (specialize.typeParameters(owner).len == 0) return hirClassName(l, owner);
    const scope = b orelse return null;
    const tuple = classTupleFor(l, owner, l.g.typeAt(receiver), scope) orelse return null;
    return H.specializationName(l.a, name, tuple) catch c.oom();
}

fn receiverClassLike(receiver_type: *c.Type) ?*Node {
    if (gt.classDeclarationOf(receiver_type)) |declaration| return declaration;
    const like = gt.classLikeOf(receiver_type) orelse return null;
    if (like.data.class.is_expr and gt.expressionClassName(like) != null) return like;
    return null;
}

pub fn receiverClass(l: *Lower, receiver: *Node) ?*Node {
    return receiverClassLike(l.g.typeAt(receiver));
}

pub fn declaringClassName(l: *Lower, receiver: *Node, method: []const u8, b: ?*Scope) ?[]const u8 {
    const receiver_type = l.g.typeAt(receiver);
    if (receiverClassLike(receiver_type) orelse gate_member.constraintDeclaration(l.g, receiver_type)) |declaration| {
        const owner = gt.methodDeclaringClass(l.g, declaration, method) orelse return null;
        return mangleClassName(l, owner, receiver, b);
    }
    const shape = l.toH(receiver_type);
    if (shape.* == .object and methodSlot(shape, method) >= 0) return shape.object.name;
    return substitutedOwner(l, receiver, &.{method}, b);
}

/// The class a receiver names once its generic type is substituted, when that class has a slot
/// for one of `methods`.
fn substitutedOwner(l: *Lower, receiver: *Node, methods: []const []const u8, b: ?*Scope) ?[]const u8 {
    const substituted = expressions.typeAt(l, receiver, b orelse return null);
    if (substituted.* != .object) return null;
    for (methods) |method| {
        if (methodSlot(substituted, method) >= 0) break;
    } else return null;
    if (specialize.genericNamesakeOf(l, substituted.object.name)) |namesake| return mangleClassName(l, namesake, receiver, b);
    return substituted.object.name;
}

fn namedClass(_: void, node: *Node) ?*Node {
    return if (node.data == .class and (!node.data.class.is_expr or gt.expressionClassName(node) != null)) node else null;
}

pub fn classesIn(l: *Lower, file: *c.File) []const *Node {
    if (l.classes_in.get(file)) |known| return known;
    const found = ast_walk.collect(*Node, l.a, file.root, {}, namedClass) catch c.oom();
    l.classes_in.put(l.a, file, found) catch c.oom();
    return found;
}

fn declaresMethod(l: *Lower, declaration: *const Node, name: []const u8) bool {
    if (isPrivateMemberName(name)) return false;
    const property = H.accessorProperty(name);
    for (classMembers(declaration)) |m| {
        if (gt.isStaticMember(m) or api.declarationName(m) == null) continue;
        const declared = gt.instanceMethodName(l.g, m) orelse continue;
        if (api.isGetAccessor(m)) {
            if (c.eql(l.accessorName(.get, declared), name)) return true;
        } else if (api.isSetAccessor(m)) {
            if (c.eql(l.accessorName(.set, declared), name)) return true;
        } else if (property == null and api.isMethodDeclaration(m) and c.eql(declared, name)) return true;
    }
    return false;
}

pub fn dispatchOf(l: *Lower, name: []const u8, method: []const u8) N.Dispatch {
    return if (isOverridden(l, name, method)) .virtual else .direct;
}

pub fn isOverridden(l: *Lower, name: []const u8, method: []const u8) bool {
    if (isPrivateMemberName(method)) return false;
    for (l.program_modules) |file| {
        for (classesIn(l, file)) |declaration| {
            const chain = gt.ancestry(l.g, declaration);
            var named = false;
            for (chain) |x| named = named or c.eql(hirClassName(l, x), name);
            if (!named) continue;
            var declaring: u32 = 0;
            for (chain) |x| {
                if (declaresMethod(l, x, method)) declaring += 1;
            }
            if (declaring > 1) return true;
        }
    }
    return false;
}

// ---- accessors

pub fn accessorCall(l: *Lower, half: H.AccessorKind, owner: []const u8, target: Expression, property: []const u8, args: []const Expression, t: *const HType, span: Span, at: *const Node) E!Expression {
    const method = l.accessorName(half, property);
    const object = target.getType();
    const slot = methodSlot(object, method);
    if (object.* != .object or slot < 0) return l.internal(at, "STA4067", l.fmt("method '{s}' has no slot in the layout of {s}", .{ method, l.hTypeName(object) }));
    return l.ex(.method_call, .{ .type = t, .span = span, .target = target, .class_name = owner, .method = method, .slot = slot, .dispatch = dispatchOf(l, object.object.name, method), .args = args });
}

pub fn accessorPlace(l: *Lower, owner: []const u8, target: Expression, key: []const u8, has_get: bool, place_type: *const HType, span: Span, at: *Node) E!assign.Place {
    const current: Expression = if (has_get) try accessorCall(l, .get, owner, target, key, &.{}, place_type, span, at) else l.undef(span);
    return .{ .current = current, .write = .{ .accessor = .{ .owner = owner, .target = target, .key = key, .span = span, .at = at } } };
}

pub const AccessorWrite = struct { owner: []const u8, target: Expression, key: []const u8, span: Span, at: *Node };

/// A setter the gate proved missing still evaluates the value, which is all the failed call did.
pub fn accessorWrite(l: *Lower, x: AccessorWrite, value: Expression, span: Span) Statement {
    const args = l.dupe(Expression, &.{value});
    const set = accessorCall(l, .set, x.owner, x.target, x.key, args, c.H_UNDEFINED, x.span, x.at) catch value;
    return l.st(.expression_statement, .{ .type = c.H_UNDEFINED, .span = span, .expression = set });
}

pub fn lowerPrivateRead(l: *Lower, priv: PrivateUse, node: *Node, target: Expression, b: *Scope) E!Expression {
    const span = l.span(node);
    const raw = propertyText(node);
    const x = node.data.prop_access;
    const owner_name = mangleClassName(l, priv.owner, x.expr, b) orelse return l.internal(node, "STA4067", l.fmt("private '{s}' names no descriptor the lowering can reach", .{raw}));
    if (privateOwnerMember(priv.owner, raw)) |member| {
        if (api.isMethodDeclaration(member)) {
            const t = target.getType();
            if (t.* != .object) return l.internal(node, "STA4049", "receiver is not an object");
            const slot = methodSlot(t, priv.property);
            if (slot < 0) return l.internal(node, "STA4067", l.fmt("method '{s}' has no slot in the layout of {s}", .{ priv.property, l.hTypeName(t) }));
            return l.ex(.method_value, .{ .type = expressions.typeAt(l, node, b), .span = span, .target = target, .class_name = owner_name, .method = priv.property, .slot = slot, .dispatch = .direct });
        }
        if (isAccessorMember(member)) return accessorCall(l, .get, owner_name, target, priv.property, &.{}, expressions.typeAt(l, node, b), span, node);
    }
    const slot = try slotOf(l, target, priv.property, node);
    return l.ex(.field_access, .{ .type = expressions.typeAt(l, node, b), .span = span, .target = target, .field = priv.property, .slot = slot });
}

pub fn staticAccessorCall(l: *Lower, half: H.AccessorKind, owner: []const u8, property: []const u8, args: []const Expression, t: *const HType, span: Span, at: *const Node, b: *Scope) E!Expression {
    const name = staticName(l, owner, l.accessorName(half, property));
    const fn_type = b.get(name) orelse return l.internal(at, "STA4066", l.fmt("static '{s}' has no function the class emitted", .{name}));
    return l.ex(.call, .{ .type = t, .span = span, .callee = l.ident(fn_type, span, name), .args = args });
}

fn staticMemberKey(l: *Lower, member: *const Node) ?[]const u8 {
    if (!gt.isStaticMember(member)) return null;
    return memberKey(l, api.declarationName(member) orelse return null, .private_name);
}

/// The key a member name spells statically: an identifier, a constant computed key, or the one
/// other spelling the caller's syntax allows (`#x` in a class, `"x"` in an object literal).
pub fn memberKey(l: *Lower, name: *Node, comptime other: anytype) ?[]const u8 {
    return switch (name.data) {
        .identifier => |x| x,
        .computed_name => gt.computedKeyStaticName(l.g, name),
        other => @field(name.data, @tagName(other)),
        else => null,
    };
}

pub fn staticAccessorHalves(l: *Lower, owner: *Node, property: []const u8) Halves {
    var out: Halves = .{};
    var seen: std.AutoHashMapUnmanaged(*Node, void) = .empty;
    var current: ?*Node = owner;
    while (current) |x| : (current = gt.baseClassOf(l.g, x)) {
        if (seen.contains(x)) break;
        seen.put(l.a, x, {}) catch c.oom();
        for (classMembers(x)) |member| {
            if (!c.eql(staticMemberKey(l, member) orelse continue, property)) continue;
            if (api.isGetAccessor(member)) out.get = true;
            if (api.isSetAccessor(member)) out.set = true;
        }
        if (std.mem.startsWith(u8, property, "#")) break;
    }
    return out;
}

pub const PropertyOwner = struct { owner: ?*Node, get: bool, set: bool };

pub fn declaringClassOfProperty(l: *Lower, receiver: *Node, property: []const u8) ?PropertyOwner {
    const receiver_type = l.g.typeAt(receiver);
    const declaration = receiverClassLike(receiver_type) orelse gate_member.constraintDeclaration(l.g, receiver_type) orelse return null;
    const found = gt.accessorDeclaringClass(l.g, declaration, property) orelse return null;
    return .{ .owner = found.owner, .get = found.get, .set = found.set };
}

pub fn accessorOwner(l: *Lower, receiver: *Node, property: []const u8, b: ?*Scope) ?[]const u8 {
    const found = declaringClassOfProperty(l, receiver, property);
    if (found) |x| if (x.owner) |owner| if (gt.classDisplayName(owner) != null) return mangleClassName(l, owner, receiver, b);
    return substitutedOwner(l, receiver, &.{ l.accessorName(.get, property), l.accessorName(.set, property) }, b);
}

pub fn hasAccessorHalf(l: *Lower, receiver: *Node, property: []const u8, half: H.AccessorKind, b: ?*Scope) bool {
    if (declaringClassOfProperty(l, receiver, property)) |found| return if (half == .get) found.get else found.set;
    if (b) |scope| {
        const substituted = expressions.typeAt(l, receiver, scope);
        return substituted.* == .object and methodSlot(substituted, l.accessorName(half, property)) >= 0;
    }
    return false;
}

// ---- class member names

pub fn sourceText(l: *Lower, n: *const Node) []const u8 {
    return l.sf.src[n.start..n.end];
}

pub fn isPrivateMemberName(name: []const u8) bool {
    return std.mem.startsWith(u8, name, "#") or std.mem.startsWith(u8, name, "get #") or std.mem.startsWith(u8, name, "set #");
}

pub fn declaredMemberName(l: *Lower, member: *const Node) []const u8 {
    return gt.instanceMethodName(l.g, member) orelse sourceText(l, api.declarationName(member).?);
}

pub fn memberDeclaresName(l: *Lower, member: *const Node, name: []const u8, owner: ?[]const u8) bool {
    if (api.declarationName(member) == null) return false;
    const declared = declaredMemberName(l, member);
    if (c.eql(declared, name)) return true;
    return if (owner) |o| c.eql(gt.privateMethodName(l.g, o, declared), name) else false;
}

pub fn memberFunctionName(l: *Lower, member: *const Node, owner: ?[]const u8) []const u8 {
    const spelled = declaredMemberName(l, member);
    const raw = if (api.isGetAccessor(member)) l.accessorName(.get, spelled) else if (api.isSetAccessor(member)) l.accessorName(.set, spelled) else spelled;
    return if (owner) |o| gt.privateMethodName(l.g, o, raw) else raw;
}

// ---- namespaces

pub fn isStaticNamespacePath(l: *Lower, node: *Node) bool {
    if (gt.namespaceModule(l.g, l.g.typeAt(node)) == null) return false;
    return node.data == .identifier or (node.data == .prop_access and isStaticNamespacePath(l, node.data.prop_access.expr));
}

pub fn namespaceMemberRead(l: *Lower, node: *Node, b: *Scope) ?Expression {
    if (node.data != .prop_access or !isStaticNamespacePath(l, node.data.prop_access.expr)) return null;
    const member = program.exportedBinding(l, module_names.exportTarget(l, l.g.symbolAt(node.data.prop_access.name)), b) orelse return null;
    return l.ident(member.type, l.span(node), member.name);
}

pub fn namespaceObjectField(l: *Lower, target: Expression, field: []const u8, b: *Scope) ?program.Binding {
    if (target != .identifier) return null;
    var entries = l.namespace_objects.iterator();
    while (entries.next()) |entry| {
        if (c.eql(entry.value_ptr.*, target.identifier.name)) {
            return program.exportedBinding(l, program.moduleExportTarget(l, entry.key_ptr.*, field), b);
        }
    }
    return null;
}
