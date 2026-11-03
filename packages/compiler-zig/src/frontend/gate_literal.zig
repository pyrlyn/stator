//! Array and object literals: which of them have a layout, and out-slots never stored in one.

const std = @import("std");
const api = @import("gate_api.zig");
const types = @import("gate_types.zig");
const narrowing = @import("narrowing.zig");
const H = @import("../hir/types.zig");

const Gate = api.Gate;
const Node = api.Node;
const Result = api.Result;
const accept = api.accept;
const oom = api.oom;

pub fn isOutSlotValue(g: *Gate, expression: *Node) bool {
    return types.outSlotInner(g, g.typeAt(expression)) != null;
}

pub fn outSlotInValuePosition(g: *const Gate, what: []const u8) Result {
    return api.never("STA1125", g.fmt("{s} cannot hold an out-slot — slots live in locals, pass to Out<T> parameters, and read through .value (docs/FFI.md)", .{what}));
}

pub fn gateArrayLiteral(g: *Gate, literal: *Node) Result {
    const parent = literal.parent;
    if (parent != null and parent.?.data == .binary and parent.?.data.binary.left == literal and parent.?.data.binary.op == .assign) return accept;
    const elements = literal.data.array_lit.elems;
    for (elements) |element| {
        if (element.data != .omitted_expr and isOutSlotValue(g, element)) return outSlotInValuePosition(g, "an array literal");
    }
    for (elements) |element| {
        if (element.data == .omitted_expr) return g.notYet("a hole in an array literal is not yet supported", 5);
    }
    return accept;
}

fn spreadOperandType(g: *Gate, expression: *Node) *const H.HType {
    const current = api.skipParens(expression);
    if (current.data == .as_expr) {
        const inner = spreadOperandType(g, current.data.as_expr.expr);
        if (narrowing.assertedBy(g, current)) |asserted| {
            if (narrowing.isCheckable(asserted) and inner.* == .unknown) return asserted;
        }
        return inner;
    }
    return types.tsTypeToHType(g, g.typeAt(current));
}

pub fn isIntegerIndex(key: []const u8) bool {
    if (key.len == 0 or (key[0] == '0' and key.len > 1)) return false;
    var value: u64 = 0;
    for (key) |b| {
        if (!std.ascii.isDigit(b)) return false;
        value = value * 10 + (b - '0');
        if (value >= 0xffffffff) return false;
    }
    return true;
}

pub fn isObjectLiteralComputedKey(name: *const Node) bool {
    const parent = name.parent orelse return false;
    if (parent.data != .property_assign and !api.isGetAccessor(parent) and !api.isSetAccessor(parent)) return false;
    const grand = parent.parent orelse return false;
    return grand.data == .object_lit;
}

pub fn isClassMemberComputedKey(name: *const Node) bool {
    const parent = name.parent orelse return false;
    const is_member = api.isMethodDeclaration(parent) or parent.data == .property_decl or api.isGetAccessor(parent) or api.isSetAccessor(parent);
    if (!is_member or api.declarationName(parent) != name) return false;
    const owner = parent.parent orelse return false;
    return api.isClassLike(owner);
}

fn isAccessor(n: *const Node) bool {
    return api.isGetAccessor(n) or api.isSetAccessor(n);
}

pub fn gateObjectLiteral(g: *Gate, literal: *Node) Result {
    const properties = literal.data.object_lit.props;
    for (properties) |property| {
        const stored = switch (property.data) {
            .func => continue,
            .spread_assign => |x| x.expr,
            .property_assign => |x| x.value,
            .shorthand_assign => |x| x.name,
            else => continue,
        };
        if (isOutSlotValue(g, stored)) return outSlotInValuePosition(g, "an object literal");
    }
    for (properties) |property| {
        if (property.data == .shorthand_assign) continue;
        if (property.data == .spread_assign) {
            const spread = spreadOperandType(g, property.data.spread_assign.expr);
            if ((spread.* == .array or spread.* == .unknown) and types.objectLiteralIsDynamic(g, literal)) continue;
            if (spread.* != .object) return g.notYet("an object spread of a value with no fixed shape is not yet supported", 5);
            if (spread.object.methods.len > 0 and std.mem.startsWith(u8, spread.object.name, "{")) {
                for (properties) |p| {
                    if (isAccessor(p)) return g.notYet("an object spread of a value with methods into an object literal with an accessor is not yet supported", 5);
                }
                const contextual = if (g.contextualType(literal)) |c| types.tsTypeToHType(g, c) else null;
                const dest = if (contextual != null and contextual.?.* == .object) contextual.? else types.tsTypeToHType(g, g.typeAt(literal));
                if (dest.* == .object and !types.objectLiteralIsDynamic(g, literal) and !H.objectFieldsPrefix(dest.object.fields, spread.object.fields)) {
                    return g.notYet("an object spread of a value with methods that does not preserve its field order is not yet supported", 5);
                }
            }
            continue;
        }
        const accessor = isAccessor(property);
        if (!accessor and !api.isMethodDeclaration(property) and property.data != .property_assign) {
            return g.notYet("an object literal with a method member is not yet supported", 5);
        }
        if (accessor) {
            if (property.data.func.name) |name| {
                if (name.data == .computed_name and types.computedKeyStaticName(g, name) == null) {
                    return g.notYet("an object literal accessor with a computed name is not yet supported", 5);
                }
            }
        }
    }
    if (types.objectLiteralIsDynamic(g, literal)) {
        if (g.contextualType(literal)) |context| {
            if (!types.isDynamicShape(g, context) and types.tsTypeToHType(g, context).* == .object) {
                for (properties) |p| {
                    if (isAccessor(p)) return g.notYet("an object literal with an accessor in a position typed as a fixed shape is not yet supported", 5);
                }
            }
        }
        return accept;
    }
    return if (types.tsTypeToHType(g, g.typeAt(literal)).* == .object)
        accept
    else
        g.notYet("an object literal whose shape is not a layout is not yet supported", 5);
}
