//! Operators: which binary, unary, assignment and delete forms have a lowering.

const std = @import("std");
const api = @import("gate_api.zig");
const types = @import("gate_types.zig");
const call_ = @import("gate_call.zig");
const core = @import("gate.zig");
const member = @import("gate_member.zig");
const H = @import("../hir/types.zig");

const Gate = api.Gate;
const Node = api.Node;
const Result = api.Result;
const Tok = api.Tok;
const accept = api.accept;
const eql = api.eql;
const oom = api.oom;

fn isSimpleAssignmentPattern(pattern: *const Node) bool {
    if (pattern.data == .object_lit) {
        for (pattern.data.object_lit.props) |p| {
            const simple = switch (p.data) {
                .shorthand_assign => |x| x.init == null,
                .property_assign => |x| api.isIdentifier(x.name) and api.isIdentifier(x.value),
                else => false,
            };
            if (!simple) return false;
        }
        return true;
    }
    for (pattern.data.array_lit.elems) |el| {
        if (el.data != .omitted_expr and !api.isIdentifier(el)) return false;
    }
    return true;
}

fn isStatementPosition(node: *const Node) bool {
    var at = node;
    while (at.parent) |parent| {
        if (parent.data != .paren) return parent.data == .expr_stmt;
        at = parent;
    }
    return false;
}

pub fn brandDeclaringClass(name: *const Node) ?*Node {
    const declaration = privateDeclaration(name) orelse return null;
    if (declaration.data != .property_decl and !api.isMethodDeclaration(declaration) and !api.isGetAccessor(declaration) and !api.isSetAccessor(declaration)) return null;
    const parent = declaration.parent orelse return null;
    return if (api.isClassLike(parent) and types.classDisplayName(parent) != null) parent else null;
}

/// A private name resolves lexically, through the enclosing classes, never through a receiver.
fn privateDeclaration(name: *const Node) ?*Node {
    const text = name.data.private_name;
    var cursor = name.parent;
    while (cursor) |n| : (cursor = n.parent) {
        if (!api.isClassLike(n)) continue;
        for (n.data.class.members) |candidate| {
            const member_name = api.declarationName(candidate) orelse continue;
            if (member_name.data == .private_name and std.mem.eql(u8, member_name.data.private_name, text)) return candidate;
        }
    }
    return null;
}

fn isArithmeticOnly(op: Tok) bool {
    return switch (op) {
        .minus, .star, .slash, .percent, .star2, .minus_assign, .star_assign, .slash_assign, .percent_assign, .star2_assign => true,
        else => false,
    };
}

fn isCompoundAssignment(op: Tok) bool {
    return op != .assign and api.expr.isAssignOp(op);
}

fn gateInstanceof(g: *Gate, bin: *Node) Result {
    const right = bin.data.binary.right;
    if (g.mode == .js and types.isFunctionValueCallee(g, right)) return accept;
    const refusal = "instanceof against anything but a class name is not yet supported";
    if (!api.isIdentifier(right)) return g.notYet(refusal, 5);
    const t = g.typeAt(right);
    const declaration = types.classDeclarationOf(t);
    const like = declaration orelse types.classLikeOf(t) orelse types.classExpressionTarget(g, right) orelse types.innerClassExpression(g, right);
    const generic = if (declaration) |d|
        d.data.class.type_params.items.len > 0
    else if (like != null and api.isClassExpression(like.?))
        like.?.data.class.type_params.items.len > 0
    else
        false;
    if (generic) {
        return g.notYet("instanceof against a generic class is not yet supported: one descriptor per tuple, and the bare name identifies no descriptor to compare against", 5);
    }
    return if (like != null or core.isInstanceofBuiltin(api.text(right) orelse "")) accept else g.notYet(refusal, 5);
}

fn gateAssignment(g: *Gate, bin: *Node) Result {
    const x = bin.data.binary;
    const left = x.left;
    if (g.mode == .js and left.data == .elem_access and isAbsentClassMemberWrite(g, left)) {
        return g.notYet("assigning a new property on a class instance is not yet supported", 8);
    }
    if (left.data == .object_lit or left.data == .array_lit) {
        return if (isStatementPosition(bin) and isSimpleAssignmentPattern(left))
            accept
        else
            g.notYet("destructuring assignment is supported only as a statement whose targets are variables, with no default, rest or nesting", 5);
    }
    if (api.isIdentifier(left) and types.outSlotInner(g, g.typeAt(left)) != null and types.outSlotInner(g, g.typeAt(x.right)) == null) {
        return api.never("STA1125", "an Out<T> binding takes only out-slots — anything else stored would read back as a handle the callee never wrote (docs/FFI.md)");
    }
    if (isAssignableTarget(g, left)) return accept;
    if (left.data == .prop_access) {
        const access = left.data.prop_access;
        if (types.isFunctionValueMember(g, access.expr, api.text(access.name) orelse "")) return call_.functionMemberResult(g);
        if (g.mode == .ts and types.tsTypeToHType(g, g.typeAt(access.expr)).* == .object) return accept;
    }
    return g.notYet("assignment to anything but a variable is not yet supported", 5);
}

pub fn gateBinary(g: *Gate, bin: *Node) Result {
    const x = bin.data.binary;
    const op = x.op;
    if (g.mode == .js and isArithmeticOnly(op)) {
        for ([_]*Node{ x.left, x.right }) |operand| {
            const t = types.tsTypeToHType(g, g.typeAt(operand));
            switch (t.*) {
                .object, .array, .map, .set, .iterator, .regexp, .date, .uint8array, .arraybuffer, .promise, .@"fn" => {
                    return g.notYet(g.fmt("arithmetic on a {s} operand is not yet supported", .{H.hTypeName(g.a, t) catch oom()}), 8);
                },
                else => {},
            }
        }
    }
    if (isCompoundAssignment(op)) {
        if (!isAssignableTarget(g, x.left)) return g.notYet("compound assignment to anything but a variable is not yet supported", 5);
        return gateUpdate(g, bin);
    }
    return switch (op) {
        .plus, .minus, .star, .slash, .percent, .lt, .gt, .lte, .gte, .eq3, .neq3, .eq2, .neq, .amp, .pipe, .caret, .shl, .shr, .ushr, .amp2, .pipe2, .qq, .star2, .comma => accept,
        .kw_instanceof => gateInstanceof(g, bin),
        .kw_in => blk: {
            if (x.left.data != .private_name) break :blk accept;
            break :blk if (brandDeclaringClass(x.left) != null) accept else g.notYet("the #brand-in-object test is not yet supported", 5);
        },
        .assign => gateAssignment(g, bin),
        else => g.notYet("this operator is not yet supported", 5),
    };
}

pub fn gatePrefixUnary(g: *Gate, unary: *Node) Result {
    const x = unary.data.prefix;
    return switch (x.op) {
        .minus, .plus, .bang, .tilde => accept,
        .plus2, .minus2 => if (isAssignableTarget(g, x.expr)) gateUpdate(g, unary) else g.notYet("++ and -- on anything but a variable are not yet supported", 5),
        else => g.notYet("this unary operator is not yet supported", 5),
    };
}

fn isAssignableTarget(g: *Gate, node: *Node) bool {
    if (api.isIdentifier(node) or node.data == .elem_access) return true;
    if (node.data != .prop_access) return false;
    const x = node.data.prop_access;
    const receiver = g.typeAt(x.expr);
    const name = api.text(x.name) orelse "";
    if (types.classLikeOf(receiver) != null or member.constraintDeclaration(g, receiver) != null) return true;
    if (member.typeParameterConstraint(g, receiver)) |constraint| {
        if (g.property(constraint, name) != null) return true;
    }
    if (types.isDynamicShape(g, receiver)) return true;
    if (g.mode == .js and (types.isFunctionValueMember(g, x.expr, name) or types.isFunctionMemberRead(g, x.expr) or types.isUndeclaredMemberRead(g, node))) return true;
    const shape = types.tsTypeToHType(g, receiver);
    return switch (shape.*) {
        .unknown => true,
        .array => eql(name, "length"),
        .object => |o| blk: {
            for (o.fields) |f| if (eql(f.name, name)) break :blk true;
            break :blk false;
        },
        else => false,
    };
}

fn isAbsentClassMemberWrite(g: *Gate, target: *Node) bool {
    const x = target.data.elem_access;
    const key = types.elementStaticKey(g, x.index) orelse return false;
    const receiver = g.typeAt(x.expr);
    return types.classDeclarationOf(receiver) != null and g.property(receiver, key) == null;
}

pub fn gateUpdate(g: *Gate, node: *Node) Result {
    const target = switch (node.data) {
        .binary => |x| x.left,
        .prefix => |x| x.expr,
        .postfix => |x| x.expr,
        else => return accept,
    };
    if (g.mode == .js and target.data == .elem_access and isAbsentClassMemberWrite(g, target)) {
        return g.notYet("assigning a new property on a class instance is not yet supported", 8);
    }
    return accept;
}

pub fn gateDelete(g: *Gate, node: *Node) Result {
    const operand = api.skipParens(node.data.delete_expr.expr);
    const receiver = switch (operand.data) {
        .prop_access => |x| x.expr,
        .elem_access => |x| x.expr,
        else => return g.notYet("delete of anything but a property access is not yet supported", 5),
    };
    const target = types.tsTypeToHType(g, g.typeAt(receiver));
    if (g.mode == .js and types.isUndeclaredMemberRead(g, operand)) return accept;
    if (target.* == .object) {
        return if (g.mode == .ts)
            api.never("STA1108", "delete on class fields is not supported in ts mode — classes have fixed shape at compile time")
        else
            api.notYetCode("STA1205", "delete on a statically-shaped object is not yet supported in js mode; planned for Phase 8 (dynamic tier)", 8);
    }
    if (target.* == .array and target.array.element.* != .unknown) {
        return g.notYet("delete of an element of an array with a typed element is not yet supported", 5);
    }
    return accept;
}
