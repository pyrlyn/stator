//! Calls and constructions. The receiver's kind picks the HIR node, so the order of the tests is
//! the order the original tries them in.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Scope = c.Scope;
const Expression = c.Expression;
const ExprList = c.ExprList;
const HType = c.HType;
const Span = c.Span;
const E = c.E;
const H = c.H;
const N = c.N;
const T = c.T;
const api = c.api;
const gt = c.gt;
const H_NUMBER = c.H_NUMBER;
const H_STRING = c.H_STRING;
const H_BOOLEAN = c.H_BOOLEAN;
const H_UNDEFINED = c.H_UNDEFINED;
const expressions = @import("expressions.zig");
const members = @import("members.zig");
const arrays = @import("arrays.zig");
const boundary = @import("boundary.zig");
const specialize = @import("specialize.zig");
const program = @import("program.zig");
const gate_globals = @import("../frontend/gate_globals.zig");
const gate_member = @import("../frontend/gate_member.zig");
const gate_extern = @import("../frontend/gate_extern.zig");
const lowerExpression = expressions.lowerExpression;
const typeAt = expressions.typeAt;

fn single(l: *Lower, e: Expression) []const Expression {
    return l.dupe(Expression, &.{e});
}

pub fn padToArity(l: *Lower, args: []const Expression, arity: usize, span: Span) []const Expression {
    if (args.len >= arity) return l.dupe(Expression, args);
    const out = l.a.alloc(Expression, arity) catch c.oom();
    @memcpy(out[0..args.len], args);
    for (out[args.len..]) |*slot| slot.* = l.undef(span);
    return out;
}

pub fn typedOpNode(l: *Lower, op: N.TypedOperation, receiver: ?Expression, args: []const Expression, span: Span) Expression {
    const shape = N.TYPED_OPS.get(op);
    const padded = padToArity(l, args, shape.arity, span);
    var all: []const Expression = padded;
    if (receiver) |r| {
        const out = l.a.alloc(Expression, padded.len + 1) catch c.oom();
        out[0] = r;
        @memcpy(out[1..], padded);
        all = out;
    }
    return l.ex(.typed_op, .{ .type = N.typedResultType(shape.result), .span = span, .op = op, .args = all });
}

pub fn globalCallNode(l: *Lower, name: N.GlobalCallName, args: []const Expression, t: *const HType, span: Span) Expression {
    return l.ex(.global_call, .{ .type = t, .span = span, .name = name, .args = padToArity(l, args, N.GLOBAL_CALLS.get(name).arity, span) });
}

fn globalFunctionNode(l: *Lower, name: []const u8, args: []const Expression, span: Span, created: *const HType) Expression {
    const arg: ?Expression = if (args.len > 0) args[0] else null;
    if (c.eql(name, "String")) {
        if (arg) |x| return l.ex(.template_literal, .{ .type = H_STRING, .span = span, .quasis = l.dupe([]const u8, &.{ "", "" }), .expressions = single(l, x) });
        return l.string(span, "");
    }
    if (c.eql(name, "Number")) {
        if (arg) |x| return l.ex(.unary_op, .{ .type = H_NUMBER, .span = span, .operator = .@"+", .operand = x });
        return l.number(span, 0);
    }
    if (c.eql(name, "Boolean")) {
        const x = arg orelse return l.ex(.boolean_literal, .{ .type = H_BOOLEAN, .span = span, .value = false });
        const not = l.ex(.unary_op, .{ .type = H_BOOLEAN, .span = span, .operator = .@"!", .operand = x });
        return l.ex(.unary_op, .{ .type = H_BOOLEAN, .span = span, .operator = .@"!", .operand = not });
    }
    const row = std.meta.stringToEnum(N.GlobalCallName, name).?;
    if (row == .Array) {
        if (args.len != 1) return l.ex(.array_literal, .{ .type = created, .span = span, .elements = args });
        return globalCallNode(l, row, args, created, span);
    }
    const t: *const HType = switch (row) {
        .@"Array.from", .@"..." => if (created.* == .array) created else l.hArray(c.hUnknown(false)),
        .RegExp => c.H_REGEXP,
        .parseInt, .parseFloat => H_NUMBER,
        .@"%ctor", .@"%proto", .@"%objectProto" => c.hUnknown(false),
        .isNaN, .isFinite, .@"Number.isFinite", .@"Number.isNaN", .@"ArrayBuffer.isView" => H_BOOLEAN,
        else => created,
    };
    return globalCallNode(l, row, args, t, span);
}

// ---- arguments

pub fn lowerArguments(l: *Lower, nodes: []const *Node, b: *Scope, outer_call: ?*Node) E![]const Expression {
    var args: ExprList = .empty;
    for (nodes) |node| {
        if (outer_call) |call| if (node.data != .spread_elem) {
            if (try specialize.specializedArgument(l, node, call, b)) |specialized| {
                l.push(&args, specialized);
                continue;
            }
        };
        l.push(&args, try lowerExpression(l, node, b));
    }
    return args.items;
}

fn lowerCallArguments(l: *Lower, node: *Node, b: *Scope) E![]const Expression {
    var args: ExprList = .empty;
    for (node.data.call.args) |argument| {
        if (argument.data == .spread_elem) {
            l.push(&args, try lowerExpression(l, argument, b));
            continue;
        }
        if (try specialize.specializedArgument(l, argument, node, b)) |specialized| {
            l.push(&args, specialized);
            continue;
        }
        l.push(&args, try lowerExpression(l, argument, b));
    }
    return args.items;
}

const ReceiverCall = struct { target: Expression, args: []const Expression, span: Span };

fn lowerReceiverCall(l: *Lower, obj: *Node, node: *Node, b: *Scope) E!ReceiverCall {
    const target = try lowerExpression(l, obj, b);
    const args = try lowerArguments(l, node.data.call.args, b, node);
    return .{ .target = target, .args = args, .span = l.span(node) };
}

fn notFunctionSubject(l: *Lower, callee: *Node) []const u8 {
    var node = callee;
    while (true) {
        if (node.data == .paren) node = node.data.paren.expr else if (node.data == .non_null) node = node.data.non_null.expr else break;
    }
    return switch (node.data) {
        .identifier, .prop_access, .elem_access, .string_lit, .numeric_lit, .bigint_lit, .no_subst_template, .true_lit, .false_lit, .null_lit => members.sourceText(l, node),
        .call => |x| l.concat(&.{ notFunctionSubject(l, x.callee), "(...)" }),
        else => "(intermediate value)",
    };
}

fn nonFunctionCall(l: *Lower, node: *Node, callee_node: *Node, callee: Expression, args: []const Expression) Expression {
    const span = l.span(node);
    var sequenced = l.ex(.type_error, .{ .type = c.hUnknown(false), .span = span, .message = l.concat(&.{ notFunctionSubject(l, callee_node), " is not a function" }) });
    var index = args.len;
    while (index > 0) {
        index -= 1;
        sequenced = l.ex(.binary_op, .{ .type = sequenced.getType(), .span = span, .operator = .@",", .left = args[index], .right = sequenced });
    }
    return l.ex(.binary_op, .{ .type = sequenced.getType(), .span = span, .operator = .@",", .left = callee, .right = sequenced });
}

pub fn userConversion(l: *Lower, node: *Node, value: Expression, method: []const u8, b: *Scope) Expression {
    const t = value.getType();
    if (t.* != .object or members.receiverClass(l, node) == null or !members.isClassInstance(l, node, b)) return value;
    const slot = members.methodSlot(t, method);
    if (slot < 0) return value;
    const signature = t.object.methods[@intCast(slot)].type;
    if (signature.* != .@"fn" or signature.@"fn".params.len != 0) return value;
    const ret = signature.@"fn".ret;
    if (ret.* != .string and ret.* != .number and ret.* != .boolean) return value;
    const owner = members.declaringClassName(l, node, method, b) orelse return value;
    return l.ex(.method_call, .{ .type = ret, .span = value.getSpan(), .target = value, .class_name = owner, .method = method, .slot = slot, .dispatch = members.dispatchOf(l, t.object.name, method), .args = &.{} });
}

fn methodCallAtSlot(l: *Lower, node: *Node, target: Expression, class_name: []const u8, method: []const u8, slot: i32, dispatch: N.Dispatch, args: []const Expression, b: *Scope) E!Expression {
    const layout = H.classLayoutOf(target.getType());
    const signature: ?*const HType = if (layout != null and slot >= 0 and slot < layout.?.methods.len) layout.?.methods[@intCast(slot)].type else null;
    return l.ex(.method_call, .{ .type = typeAt(l, node, b), .span = l.span(node), .target = target, .class_name = class_name, .method = method, .slot = slot, .dispatch = dispatch, .args = boundary.checkCallArgs(l, signature, args, node) });
}

fn missingMethodSlot(l: *Lower, at: *const Node, method: []const u8, target: Expression) E {
    return l.internal(at, "STA4067", l.fmt("method '{s}' has no slot in the layout of {s}", .{ method, l.hTypeName(target.getType()) }));
}

fn lowerClassMethodCall(l: *Lower, obj: *Node, prop_name: []const u8, priv_name: ?*Node, via_super: bool, node: *Node, at: *Node, b: *Scope) E!?Expression {
    if (!via_super and at.data == .prop_access and gt.isUndeclaredMemberRead(l.g, at)) return null;
    const target = if (via_super) try members.receiverIdentifier(l, obj, b) else try lowerExpression(l, obj, b);
    const t = target.getType();
    const layout = H.classLayoutOf(t) orelse return l.internal(at, "STA4049", "receiver is not an object");
    const args = try lowerArguments(l, node.data.call.args, b, node);
    if (priv_name != null and !via_super) {
        const priv = members.privateUse(l, priv_name.?) orelse return l.internal(at, "STA4067", l.fmt("private '{s}' names no class the gate accepted", .{priv_name.?.data.private_name}));
        const owner = members.mangleClassName(l, priv.owner, obj, b);
        const slot = members.methodSlot(t, priv.property);
        if (owner == null or slot < 0) return missingMethodSlot(l, at, priv.property, target);
        return try methodCallAtSlot(l, node, target, owner.?, priv.property, slot, .direct, args, b);
    }
    if (members.declaringClassName(l, obj, prop_name, b)) |owner| {
        const slot = members.methodSlot(t, prop_name);
        if (slot < 0) return missingMethodSlot(l, at, prop_name, target);
        const dispatch: N.Dispatch = if (!via_super and members.isOverridden(l, layout.name, prop_name)) .virtual else .direct;
        return try methodCallAtSlot(l, node, target, owner, prop_name, slot, dispatch, args, b);
    }
    if (l.g.property(l.g.typeAt(obj), prop_name) == null) return nonFunctionCall(l, node, at, target, args);
    return null;
}

pub const NullableMethod = struct { class_name: []const u8, slot: i32, dispatch: N.Dispatch, object_type: *const HType };

pub fn nullableMethodInfo(l: *Lower, receiver: *Node, field: []const u8, b: *Scope) ?NullableMethod {
    const receiver_type = l.g.typeAt(receiver);
    var live: std.ArrayList(*c.Type) = .empty;
    if (api.isUnionType(receiver_type)) {
        for (api.parts(l.g, receiver_type)) |t| {
            if (t.data != .null and t.data != .undefined and t.data != .void) l.push(&live, t);
        }
    } else l.push(&live, receiver_type);
    if (live.items.len == 0) return null;
    var declaration: ?*Node = null;
    for (live.items) |constituent| {
        if (constituent.data == .any or constituent.data == .unknown) return null;
        const d = gt.classDeclarationOf(constituent) orelse return null;
        if (d.data.class.name == null or specialize.typeParameters(d).len > 0) return null;
        if (declaration != null and declaration.? != d) return null;
        declaration = d;
    }
    const d = declaration.?;
    if (l.hirNameOf(d)) |hir| if (!c.eql(hir, api.text(d.data.class.name.?) orelse "")) return null;
    const owner = gt.methodDeclaringClass(l.g, d, field) orelse return null;
    const class_name = members.mangleClassName(l, owner, receiver, b) orelse return null;
    const object_type = l.toH(live.items[0]);
    if (object_type.* != .object) return null;
    const slot = members.methodSlot(object_type, field);
    if (slot < 0) return null;
    return .{ .class_name = class_name, .slot = slot, .dispatch = members.dispatchOf(l, object_type.object.name, field), .object_type = object_type };
}

pub fn methodValue(l: *Lower, node: *Node, target: Expression, layout: *const HType, method: []const u8, class_name: []const u8, virtual: bool, b: *Scope) E!Expression {
    const slot = members.methodSlot(layout, method);
    if (slot < 0) return l.internal(node, "STA4067", l.fmt("method '{s}' has no slot in the layout of {s}", .{ method, l.hTypeName(layout) }));
    return l.ex(.method_value, .{ .type = typeAt(l, node, b), .span = l.span(node), .target = target, .class_name = class_name, .method = method, .slot = slot, .dispatch = if (virtual) .virtual else .direct });
}

pub fn lowerClassMemberRead(l: *Lower, target: Expression, field: []const u8, receiver: *Node, node: *Node, b: *Scope) E!Expression {
    const span = l.span(node);
    if (members.namespaceObjectField(l, target, field, b)) |member| return l.ident(member.type, span, member.name);
    const t = target.getType();
    if (members.declaringClassName(l, receiver, field, b)) |method_owner| {
        if (t.* != .object) return l.internal(node, "STA4049", "receiver is not an object");
        return methodValue(l, node, target, t, field, method_owner, members.isOverridden(l, t.object.name, field), b);
    }
    if (members.accessorOwner(l, receiver, field, b)) |owner| {
        return members.accessorCall(l, .get, owner, target, field, &.{}, typeAt(l, node, b), span, node);
    }
    const known: ?usize = if (t.* == .object) H.fieldSlot(&t.object, field) else null;
    if (t.* == .unknown or (known == null and l.g.property(l.g.typeAt(receiver), field) == null)) {
        return l.ex(.dyn_field_access, .{ .type = c.hUnknown(false), .span = span, .target = target, .field = field });
    }
    const slot = try members.slotOf(l, target, field, node);
    return l.ex(.field_access, .{ .type = typeAt(l, node, b), .span = span, .target = target, .field = field, .slot = slot });
}

// ---- dynamic and spread calls

fn lowerDynMethodCall(l: *Lower, node: *Node, e: *Node, b: *Scope) E!?Expression {
    if (e.data != .prop_access) return null;
    const x = e.data.prop_access;
    const obj = x.expr;
    if (obj.data == .super_expr or gate_member.isMatchReceiver(l.g, obj)) return null;
    const name = members.propertyText(e);
    const receiver = members.receiverTypeAt(l, obj, b);
    const slot = H.callableFieldSlot(receiver, name);
    const function_member = gt.isFunctionValueMember(l.g, obj, name);
    const grown = gt.isUndeclaredMemberRead(l.g, e);
    const call_apply = (c.eql(name, "call") or c.eql(name, "apply")) and gate_globals.isPlainFunctionValue(l.g, obj);
    var field_value = false;
    if (slot == null and receiver.* == .object and receiver.object.namespace != true) {
        for (receiver.object.fields) |field| {
            if (c.eql(field.name, name) and (field.type.* == .null or field.type.* == .undefined or field.type.* == .unknown)) field_value = true;
        }
    }
    if (receiver.* != .unknown and slot == null and !function_member and !grown and !call_apply and !field_value) return null;
    const target = try lowerExpression(l, obj, b);
    const args = try lowerCallArguments(l, node, b);
    const t = if (function_member or grown or call_apply or field_value) c.hUnknown(false) else typeAt(l, node, b);
    const span = l.span(node);
    if (slot) |s| return l.ex(.field_call, .{ .type = t, .span = span, .target = target, .field = name, .slot = @intCast(s), .args = args });
    return l.ex(.dyn_method_call, .{ .type = t, .span = span, .target = target, .method = name, .args = args, .not_function = notFunctionSubject(l, e) });
}

fn spreadListType(l: *Lower, segments: []const arrays.Segment) *const HType {
    var first: ?*const HType = null;
    var same = true;
    for (segments) |segment| switch (segment) {
        .elems => |list| for (list.items) |elem| {
            const t = elem.getType();
            if (first == null) first = t else same = same and H.hTypeEquals(t, first.?);
        },
        .spread => |spread| {
            const st = spread.getType();
            const t = if (st.* == .array) st.array.element else c.hUnknown(false);
            if (first == null) first = t else same = same and H.hTypeEquals(t, first.?);
        },
    };
    return if (first != null and same) l.hArray(first.?) else l.hArray(c.hUnknown(false));
}

fn isNamespaceReceiver(l: *Lower, receiver: *Node) bool {
    if (receiver.data != .identifier) return false;
    const symbol = l.g.symbolAt(receiver) orelse return false;
    const resolved = if (api.isAlias(symbol)) l.g.aliased(symbol) orelse return false else symbol;
    return resolved.flags & c.F.value_module != 0 or hasTopLevelExpando(l, resolved);
}

/// tsc binds a function as a module too once a top-level statement gives it a member. stator-ts
/// keeps the flag off, where it would turn the function's value into a namespace.
fn hasTopLevelExpando(l: *Lower, symbol: *c.Symbol) bool {
    const table = symbol.exports orelse return false;
    if (symbol.flags & c.F.function == 0) return false;
    for (table.ordered(l.a)) |member| {
        for (member.decls) |left| {
            if (left.data != .prop_access and left.data != .elem_access) continue;
            const assignment = left.parent orelse continue;
            if (assignment.data != .binary) continue;
            const statement = assignment.parent orelse continue;
            if (api.isSourceFile(statement.parent orelse continue)) return true;
        }
    }
    return false;
}

const SpreadLower = struct {
    l: *Lower,
    node: *Node,
    b: *Scope,

    pub fn lower(s: SpreadLower, argument: *Node) E!Expression {
        if (try specialize.specializedArgument(s.l, argument, s.node, s.b)) |specialized| return specialized;
        return lowerExpression(s.l, argument, s.b);
    }
};

fn lowerSpreadArgs(l: *Lower, node: *Node, span: Span, b: *Scope) E![]const Expression {
    const segments = try arrays.lowerSpreadSegments(l, node.data.call.args, SpreadLower{ .l = l, .node = node, .b = b });
    return single(l, arrays.foldSpreadList(l, segments.items, spreadListType(l, segments.items), span));
}

fn lowerSpreadCall(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const e = node.data.call.callee;
    const span = l.span(node);
    if (e.data == .prop_access and gt.staticMemberOf(l.g, e, true) == null and !isNamespaceReceiver(l, e.data.prop_access.expr)) {
        const x = e.data.prop_access;
        const target = try lowerExpression(l, x.expr, b);
        const args = try lowerSpreadArgs(l, node, span, b);
        const name = members.propertyText(e);
        const t = if (gt.isFunctionValueMember(l.g, x.expr, name)) c.hUnknown(false) else typeAt(l, node, b);
        return l.ex(.dyn_method_call, .{ .type = t, .span = span, .target = target, .method = name, .args = args, .spread = true });
    }
    const callee = (try specialize.specializedCallee(l, node, b)) orelse try lowerExpression(l, e, b);
    const args = try lowerSpreadArgs(l, node, span, b);
    if (callee.getType().* != .@"fn" and callee.getType().* != .unknown) return nonFunctionCall(l, node, e, callee, args);
    return l.ex(.call, .{ .type = typeAt(l, node, b), .span = span, .callee = callee, .args = args, .spread = true });
}

// ---- extern

fn lowerExternCall(l: *Lower, node: *Node, decl: *Node, b: *Scope) E!Expression {
    const classified = gate_extern.classifyExternDeclaration(l.g, decl);
    if (classified != .ok) return l.internal(node, "STA4031", "extern call the gate refused reached the lowering");
    const signature = classified.ok;
    const sites = node.data.call.args;
    if (sites.len != signature.params.len) return l.internal(node, "STA4031", "extern call with an arity the gate refused reached the lowering");
    const lowered = try lowerArguments(l, sites, b, null);
    const args = l.a.alloc(Expression, lowered.len) catch c.oom();
    const tags = l.a.alloc(?[]const u8, lowered.len) catch c.oom();
    for (lowered, sites, signature.params, 0..) |arg, site, kind, index| {
        tags[index] = null;
        if (kind == .@"out-pointer") {
            const unwrapped = if (site.data == .paren) site.data.paren.expr else site;
            const is_fresh = unwrapped.data == .call and gate_extern.outSlotDeclarationOf(l.g, unwrapped) != null;
            if (unwrapped.data != .identifier and !is_fresh) return l.internal(node, "STA4031", "extern call with a non-slot out-pointer argument reached the lowering");
            tags[index] = gate_extern.outInnerTag(l.g, l.g.typeAt(decl.data.func.params[index])) orelse return l.internal(node, "STA4031", "extern call with an unspellable out-pointer parameter reached the lowering");
        }
        const wanted = N.externKindHType(kind);
        args[index] = if (kind == .bytes and arg.getType().* != .uint8array) boundary.boundaryCheck(l, arg, wanted, site) else boundary.maybeBoundary(l, arg, wanted, site, false);
    }
    return l.ex(.extern_call, .{
        .type = N.externKindHType(signature.ret),
        .span = l.span(node),
        .c_name = signature.c_name,
        .ts_name = signature.ts_name,
        .args = args,
        .arg_kinds = signature.params,
        .arg_tags = tags,
        .ret_kind = signature.ret,
        .@"error" = signature.@"error",
        .header = gate_extern.headerOf(l.g, l.fileOfNode(decl)),
    });
}

fn collectionOperation(name: []const u8) ?N.CollectionOperation {
    return std.meta.stringToEnum(N.CollectionOperation, name);
}

// ---- `new`

fn isWeakCollection(l: *Lower, node: *Node) bool {
    const t = l.g.typeAt(node);
    return gt.isLibInterface(l.g, t, "WeakMap") or gt.isLibInterface(l.g, t, "WeakSet");
}

pub fn lowerNew(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const x = node.data.new_expr;
    const raw_args = x.args;
    if (gt.isFunctionValueCallee(l.g, x.callee)) {
        const target = lowerExpression(l, x.callee, b);
        const args = lowerArguments(l, raw_args, b, null);
        return l.ex(.new_value, .{ .type = c.hUnknown(false), .span = l.span(node), .target = try target, .args = try args });
    }
    const t = typeAt(l, node, b);
    const global_function = gate_globals.globalFunctionOf(l.g, x.callee);
    if (global_function) |name| if (c.eql(name, "RegExp") or c.eql(name, "Array")) {
        const args = try lowerArguments(l, raw_args, b, null);
        return globalFunctionNode(l, name, args, l.span(node), t);
    };
    if (t.* == .map or t.* == .set) {
        return l.ex(.collection_new, .{ .type = t, .span = l.span(node), .collection = if (t.* == .map) .map else .set, .weak = isWeakCollection(l, node) });
    }
    const span = l.span(node);
    const args = try lowerArguments(l, raw_args, b, null);
    if (gate_globals.errorCtorName(l.g, x.callee)) |ctor| {
        const arg = if (args.len > 0) args[0] else l.string(span, "");
        return l.ex(.error_new, .{ .type = N.errorHType(ctor), .span = span, .ctor = ctor, .arg = arg });
    }
    if (t.* == .uint8array or t.* == .arraybuffer) {
        const op = typedOpNode(l, if (t.* == .uint8array) .@"new Uint8Array" else .@"new ArrayBuffer", null, args, span);
        // A subclass has no constructor of its own (the gate's rule), so its `new` IS the builtin
        // one with the class stamped on the view.
        if (t.* == .uint8array) if (t.uint8array.subclass) |subclass| {
            var stamped = op.typed_op.*;
            stamped.type = t;
            stamped.view_class = subclass.name;
            return .{ .typed_op = l.create(stamped) };
        };
        return op;
    }
    if (t.* == .date) {
        if (args.len >= 2) return l.ex(.date_components, .{ .type = t, .span = span, .args = padToArity(l, args, 7, span) });
        const arg = if (args.len > 0) args[0] else l.ex(.date_static, .{ .type = H_NUMBER, .span = span, .method = .now, .args = &.{} });
        return l.ex(.date_new, .{ .type = t, .span = span, .arg = arg });
    }
    if (t.* == .promise) {
        if (args.len == 0) return l.internal(node, "STA4031", "new Promise without an executor reached lowering");
        return l.ex(.promise_construct, .{ .type = t, .span = span, .executor = args[0] });
    }
    if (t.* != .object) return l.internal(node, "STA4062", l.fmt("new produced {s}, which is not a class instance", .{l.hTypeName(t)}));
    const specialized = try specialize.specializedClassName(l, node, b);
    const instance_type = if (specialized == null) t else expressions.normalizeClassInstance(l, node, t, b);
    return l.ex(.new, .{ .type = instance_type, .span = span, .class_name = specialized orelse t.object.name, .args = boundary.checkCallArgs(l, null, args, node) });
}

// ---- calls

fn prologueArgs(l: *Lower, node: *Node, b: *Scope) E![]const Expression {
    return lowerArguments(l, node.data.call.args, b, node);
}

fn soleArg(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const args = try lowerArguments(l, node.data.call.args, b, null);
    return if (args.len > 0) args[0] else error.Refused;
}

fn lowerConsole(l: *Lower, node: *Node, prop_name: []const u8, method: N.ConsoleMethod, b: *Scope) E!Expression {
    _ = prop_name;
    const given = try prologueArgs(l, node, b);
    const span = l.span(node);
    const shape = N.CONSOLE_METHODS.get(method);
    const args = if (shape.bare == null and shape.variadic == null) padToArity(l, given, shape.arity, span) else given;
    return l.ex(.console_log, .{ .type = typeAt(l, node, b), .span = span, .method = method, .args = args });
}

fn lowerObjectStatic(l: *Lower, node: *Node, method: N.ObjectStaticMethod, b: *Scope) E!Expression {
    const args = try prologueArgs(l, node, b);
    const span = l.span(node);
    const checker_type = typeAt(l, node, b);
    const t: *const HType = switch (method) {
        .keys, .getOwnPropertyNames => l.hArray(H_STRING),
        .hasOwn, .isFrozen => H_BOOLEAN,
        .fromEntries, .assign => c.hUnknown(false),
        .freeze => if (args.len > 0) args[0].getType() else checker_type,
        else => if (checker_type.* == .array) checker_type else l.hArray(c.hUnknown(false)),
    };
    return l.ex(.object_static, .{ .type = t, .span = span, .method = method, .args = args });
}

fn lowerMath(l: *Lower, node: *Node, name: []const u8, b: *Scope) E!Expression {
    const args = try prologueArgs(l, node, b);
    const span = l.span(node);
    if (c.eql(name, "min") or c.eql(name, "max")) {
        const is_min = c.eql(name, "min");
        if (args.len == 0) return l.number(span, if (is_min) std.math.inf(f64) else -std.math.inf(f64));
        var folded = args[0];
        for (args[1..]) |next| {
            folded = l.ex(.math_call, .{ .type = H_NUMBER, .span = span, .method = if (is_min) .min else .max, .args = l.dupe(Expression, &.{ folded, next }) });
        }
        return folded;
    }
    if (c.eql(name, "hypot") and args.len < 2) {
        if (args.len == 0) return l.number(span, 0);
        return l.ex(.math_call, .{ .type = H_NUMBER, .span = span, .method = .abs, .args = args });
    }
    return l.ex(.math_call, .{ .type = H_NUMBER, .span = span, .method = std.meta.stringToEnum(N.MathMethod, name).?, .args = args });
}

fn lowerStringOp(l: *Lower, obj: *Node, node: *Node, op: N.StringOpName, b: *Scope) E!Expression {
    const p = try lowerReceiverCall(l, obj, node, b);
    if (op == .concat and p.args.len != 1) {
        var folded = p.target;
        for (p.args) |next| folded = l.ex(.string_op, .{ .type = H_STRING, .span = p.span, .op = .concat, .target = folded, .args = single(l, next) });
        return folded;
    }
    return shapedOp(l, p, node, b, .string_op, op);
}

fn lowerArrayOp(l: *Lower, obj: *Node, node: *Node, op: N.ArrayOpName, b: *Scope) E!Expression {
    return shapedOp(l, try lowerReceiverCall(l, obj, node, b), node, b, .array_op, op);
}

/// A string or array method: the arguments padded to its table arity, the result typed by its shape.
fn shapedOp(l: *Lower, p: ReceiverCall, node: *Node, b: *Scope, comptime tag: std.meta.Tag(Expression), op: anytype) Expression {
    const shape = if (tag == .string_op) N.STRING_OPS.get(op) else N.ARRAY_OPS.get(op);
    const padded = padToArity(l, p.args, shape.arity, p.span);
    const checker_type = typeAt(l, node, b);
    const t: *const HType = if (tag == .string_op) switch (shape.result) {
        .element, .match => c.hUnknown(false),
        .@"string-array" => l.hArray(H_STRING),
        .number => H_NUMBER,
        .boolean => H_BOOLEAN,
        .iterator => if (checker_type.* == .iterator) checker_type else l.hIterator(c.hUnknown(false)),
        else => H_STRING,
    } else switch (shape.result) {
        .self => p.target.getType(),
        .checker, .iterator => checker_type,
        .mapped => if (checker_type.* == .array) checker_type else l.hArray(c.hUnknown(false)),
        .undefined => H_UNDEFINED,
        .number => H_NUMBER,
        .boolean => H_BOOLEAN,
        .string => H_STRING,
        else => c.hUnknown(false),
    };
    return l.ex(tag, .{ .type = t, .span = p.span, .op = op, .target = p.target, .args = padded });
}

fn substitutedKind(l: *Lower, obj: *Node, b: *Scope) ?std.meta.Tag(HType) {
    if (l.g.typeAt(obj).data != .param) return null;
    return std.meta.activeTag(typeAt(l, obj, b).*);
}

fn lowerMemberCall(l: *Lower, node: *Node, e: *Node, b: *Scope) E!?Expression {
    const x = e.data.prop_access;
    const obj = x.expr;
    const name = members.propertyText(e);
    const g = l.g;
    if (obj.data == .identifier and c.eql(obj.data.identifier, "console")) {
        if (std.meta.stringToEnum(N.ConsoleMethod, name)) |method| return try lowerConsole(l, node, name, method, b);
    }
    if (gate_globals.isGlobalObject(g, obj)) if (std.meta.stringToEnum(N.ObjectStaticMethod, name)) |method| return try lowerObjectStatic(l, node, method, b);
    if (gate_globals.isGlobalDate(g, obj)) if (std.meta.stringToEnum(N.DateStatic, name)) |method| {
        const args = try prologueArgs(l, node, b);
        const span = l.span(node);
        return l.ex(.date_static, .{ .type = H_NUMBER, .span = span, .method = method, .args = padToArity(l, args, N.DATE_STATICS.get(method).arity, span) });
    };
    if (gate_globals.isGlobalJson(g, obj)) {
        const arg = try soleArg(l, node, b);
        const span = l.span(node);
        if (c.eql(name, "parse")) return l.ex(.json_parse, .{ .type = c.hUnknown(false), .span = span, .arg = arg });
        return l.ex(.json_stringify, .{ .type = H_STRING, .span = span, .arg = arg });
    }
    if (gate_globals.isGlobalPromise(g, obj)) if (std.meta.stringToEnum(N.PromiseStaticMethod, name)) |method| {
        const arg = try soleArg(l, node, b);
        const span = l.span(node);
        const checker_type = typeAt(l, node, b);
        return l.ex(.promise_static, .{ .type = if (checker_type.* == .promise) checker_type else l.hPromise(c.hUnknown(false)), .span = span, .method = method, .arg = arg });
    };
    if (gate_globals.isGlobalString(g, obj)) if (std.meta.stringToEnum(N.StringStaticMethod, name)) |method| {
        const args = try prologueArgs(l, node, b);
        return l.ex(.string_static, .{ .type = H_STRING, .span = l.span(node), .method = method, .args = args });
    };
    if (gate_globals.isGlobalArray(g, obj) and c.eql(name, "isArray")) {
        const args = try prologueArgs(l, node, b);
        const span = l.span(node);
        return l.ex(.instanceof, .{ .type = H_BOOLEAN, .span = span, .target = if (args.len > 0) args[0] else l.undef(span), .class_name = "Array", .builtin = true });
    }
    const receiver_type = members.receiverTypeAt(l, obj, b);
    if (receiver_type.* == .promise) if (std.meta.stringToEnum(N.PromiseInstanceMethod, name)) |method| {
        const given = try prologueArgs(l, node, b);
        const span = l.span(node);
        const target = try lowerExpression(l, obj, b);
        const args = padToArity(l, given, if (method == .then) 2 else 1, span);
        const checker_type = typeAt(l, node, b);
        return l.ex(.promise_method, .{ .type = if (checker_type.* == .promise) checker_type else l.hPromise(c.hUnknown(false)), .span = span, .method = method, .target = target, .args = args });
    };
    if (gate_globals.isGlobalMath(g, obj) and gate_globals.isMathMethod(name)) return try lowerMath(l, node, name, b);
    if (receiver_type.* == .number) if (std.meta.stringToEnum(N.NumberOperation, name)) |op| {
        const p = try lowerReceiverCall(l, obj, node, b);
        return l.ex(.number_op, .{ .type = H_STRING, .span = p.span, .op = op, .target = p.target, .args = padToArity(l, p.args, 1, p.span) });
    };
    const not_unknown = receiver_type.* != .unknown;
    if (not_unknown and (gate_globals.isDateReceiver(g, obj) or substitutedKind(l, obj, b) == .date)) if (std.meta.stringToEnum(N.DateOperation, name)) |op| {
        const p = try lowerReceiverCall(l, obj, node, b);
        const shape = N.DATE_OPS.get(op);
        return l.ex(.date_op, .{ .type = if (shape.result == .number) H_NUMBER else H_STRING, .span = p.span, .op = op, .target = p.target, .args = padToArity(l, p.args, shape.arity, p.span) });
    };
    if (receiver_type.* == .uint8array or receiver_type.* == .arraybuffer) {
        const typed: N.TypedReceiver = if (receiver_type.* == .uint8array) .uint8array else .arraybuffer;
        if (N.typedMember(typed, name)) |op| if (N.TYPED_OPS.get(op).form == .call) {
            const p = try lowerReceiverCall(l, obj, node, b);
            return typedOpNode(l, op, p.target, p.args, p.span);
        };
    }
    if (not_unknown and (gate_member.isRegExpReceiver(g, obj) or substitutedKind(l, obj, b) == .regexp)) if (std.meta.stringToEnum(N.RegExpOperation, name)) |op| {
        const p = try lowerReceiverCall(l, obj, node, b);
        return l.ex(.regexp_op, .{ .type = typeAt(l, node, b), .span = p.span, .op = op, .target = p.target, .args = p.args });
    };
    if (not_unknown and (gate_member.isStringReceiver(g, obj) or substitutedKind(l, obj, b) == .string)) if (std.meta.stringToEnum(N.StringOpName, name)) |op| return try lowerStringOp(l, obj, node, op, b);
    if ((c.eql(name, "next") or c.eql(name, "return") or c.eql(name, "throw")) and typeAt(l, obj, b).* == .iterator) {
        if (!c.eql(name, "next") and !gate_member.isGeneratorReceiver(g, obj)) return l.internal(e, "STA4071", l.fmt("Iterator.{s} reached the lowering on a non-generator receiver", .{name}));
        const target = try lowerExpression(l, obj, b);
        const span = l.span(node);
        const args = node.data.call.args;
        const sent = if (args.len > 0) try lowerExpression(l, args[0], b) else l.undef(span);
        return l.ex(.iterator_next, .{ .type = typeAt(l, node, b), .span = span, .target = target, .op = std.meta.stringToEnum(N.IteratorNextOp, name).?, .sent = sent });
    }
    if (not_unknown and (gate_member.isArrayReceiver(g, obj) or substitutedKind(l, obj, b) == .array)) if (std.meta.stringToEnum(N.ArrayOpName, name)) |op| return try lowerArrayOp(l, obj, node, op, b);
    const receiver = members.receiverTypeAt(l, obj, b);
    if (receiver.* == .map or receiver.* == .set) {
        const target = try lowerExpression(l, obj, b);
        const args = try prologueArgs(l, node, b);
        const op = collectionOperation(name) orelse return l.internal(e, "STA4069", l.fmt("'{s}' is not an operation of a {s}", .{ name, l.hTypeName(receiver) }));
        return l.ex(.collection_op, .{ .type = typeAt(l, node, b), .span = l.span(node), .collection = if (receiver.* == .map) .map else .set, .op = op, .target = target, .args = args });
    }
    if (members.isClassInstance(l, obj, b)) {
        const private: ?*Node = if (x.name.data == .private_name) x.name else null;
        if (try lowerClassMethodCall(l, obj, name, private, obj.data == .super_expr, node, e, b)) |lowered| return lowered;
    }
    if (x.optional and obj.data != .super_expr and x.name.data != .private_name and l.optional_chain_cuts.contains(obj)) {
        if (nullableMethodInfo(l, obj, name, b)) |info| {
            const raw = try lowerExpression(l, obj, b);
            const args = try prologueArgs(l, node, b);
            const target = l.ex(.optional_base, .{ .type = info.object_type, .span = raw.getSpan() });
            return l.ex(.method_call, .{ .type = typeAt(l, node, b), .span = l.span(node), .target = target, .class_name = info.class_name, .method = name, .slot = info.slot, .dispatch = info.dispatch, .args = args });
        }
    }
    return null;
}

pub fn lowerCall(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const call = node.data.call;
    const e = call.callee;
    if (e.data == .import_kw) return program.lowerImportCall(l, node, b);
    for (call.args) |argument| if (argument.data == .spread_elem) return lowerSpreadCall(l, node, b);
    if (gate_globals.globalFunctionOf(l.g, e)) |name| {
        const args = try prologueArgs(l, node, b);
        var converted = args;
        if (c.eql(name, "String") and args.len > 0 and call.args.len > 0) {
            const copy = l.dupe(Expression, args);
            @constCast(copy)[0] = userConversion(l, call.args[0], args[0], "toString", b);
            converted = copy;
        }
        return globalFunctionNode(l, name, converted, l.span(node), typeAt(l, node, b));
    }
    if (e.data == .prop_access) {
        if (try lowerMemberCall(l, node, e, b)) |lowered| return lowered;
    }
    if (e.data == .elem_access and members.isClassInstance(l, e.data.elem_access.expr, b)) {
        const x = e.data.elem_access;
        if (gt.elementStaticKey(l.g, x.index)) |key| {
            if (try lowerClassMethodCall(l, x.expr, key, null, false, node, e, b)) |lowered| return lowered;
        }
    }
    if (e.data == .elem_access and gt.isSymbolIteratorKey(l.g, e.data.elem_access.index) and members.isClassInstance(l, e.data.elem_access.expr, b)) {
        if (try lowerClassMethodCall(l, e.data.elem_access.expr, gt.iterator_method_name, null, false, node, e, b)) |lowered| return lowered;
    }
    if (gate_extern.outSlotDeclarationOf(l.g, node) != null) {
        if (gate_extern.gateOutSlotCall(l.g, node) != .accept) return l.internal(node, "STA4031", "outSlot call the gate refused reached the lowering");
        return l.ex(.out_new, .{ .type = c.hUnknown(false), .span = l.span(node) });
    }
    if (gate_extern.externDeclarationOfCall(l.g, node)) |decl| return lowerExternCall(l, node, decl, b);
    const specialized = try specialize.specializedCallee(l, node, b);
    if (specialized == null) {
        if (try lowerDynMethodCall(l, node, e, b)) |dyn| return dyn;
    }
    const callee = specialized orelse try lowerExpression(l, e, b);
    const args = try lowerCallArguments(l, node, b);
    const ct = callee.getType();
    if (ct.* != .@"fn" and ct.* != .unknown) return nonFunctionCall(l, node, e, callee, args);
    return l.ex(.call, .{ .type = typeAt(l, node, b), .span = l.span(node), .callee = callee, .args = boundary.checkCallArgs(l, ct, args, node) });
}
