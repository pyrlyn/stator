//! `lowerExpression`: the one dispatch from a checked expression to HIR. The order of the tests is
//! the semantics, because a node can answer several of them, and lowering a receiver twice is kept
//! where the original does it: the second lowering is the one that names temporaries.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Scope = c.Scope;
const Expression = c.Expression;
const HType = c.HType;
const Span = c.Span;
const E = c.E;
const H = c.H;
const N = c.N;
const T = c.T;
const api = c.api;
const gt = c.gt;
const narrowing = c.narrowing;
const H_NUMBER = c.H_NUMBER;
const H_STRING = c.H_STRING;
const H_BOOLEAN = c.H_BOOLEAN;
const H_UNDEFINED = c.H_UNDEFINED;
const assign = @import("assign.zig");
const members = @import("members.zig");
const calls = @import("calls.zig");
const objects = @import("objects.zig");
const arrays = @import("arrays.zig");
const functions = @import("functions.zig");
const specialize = @import("specialize.zig");
const boundary = @import("boundary.zig");
const module_names = @import("module_names.zig");
const gate_core = c.gate;
const gate_globals = @import("../frontend/gate_globals.zig");
const gate_member = @import("../frontend/gate_member.zig");
const gate_generics = @import("../frontend/gate_generics.zig");
const gate_ops = @import("../frontend/gate_ops.zig");
const node_field = @import("../support/node_field.zig");

/// Type parameters bound by the specialization being lowered.
pub const BoundParameters = struct {
    l: *Lower,
    b: *Scope,

    pub fn lookup(s: BoundParameters, name: []const u8) ?*const HType {
        return s.b.get(specialize.typeParameterKey(s.l, name));
    }
};

pub fn ground(l: *Lower, t: *const HType, b: *Scope) *const HType {
    return H.substituteHType(l.a, t, BoundParameters{ .l = l, .b = b }) catch c.oom();
}

fn checkerTypeAt(l: *Lower, node: *Node) *c.Type {
    if (node.parent) |parent| if (parent.data == .export_assign and parent.data.export_assign.expr == node) {
        if (l.session().moduleOf(l.fileOfNode(parent))) |module| {
            for (l.session().exportsOfModule(module)) |symbol| {
                if (c.eql(api.symbolName(symbol) orelse "", "default")) return l.g.typeOfSymbol(symbol);
            }
        }
    };
    return l.g.typeAt(node);
}

fn dynamicSymbolName(l: *Lower, node: *Node) ?*c.Symbol {
    return switch (node.data) {
        .param => |p| if (p.name.data == .identifier) l.g.symbolAt(p.name) else null,
        .func => |f| if (f.name) |name| l.g.symbolAt(name) else null,
        else => l.g.symbolAt(node),
    };
}

pub fn typeAt(l: *Lower, node: *Node, b: *Scope) *const HType {
    const is_function_declaration = node.data == .func and node.data.func.kind == .decl;
    if (node.data == .identifier or node.data == .param or is_function_declaration) {
        if (node.data == .identifier and assign.isUnresolvableIdentifier(l, node, b)) return c.hUnknown(false);
        if (l.has_runtime_dynamic_symbols) {
            if (dynamicSymbolName(l, node)) |symbol| {
                if (b.has(l.concat(&.{ "\x00dynamic:", l.fqn(symbol) }))) return c.hUnknown(false);
            }
        }
    }
    if (l.has_dynamic_return_symbols and node.data == .call) {
        if (boundary.calledFunctionFQN(l, node)) |fqn| {
            if (b.has(l.concat(&.{ "\x00dynamic-return:", fqn }))) return c.hUnknown(false);
        }
    }
    const t = ground(l, l.toH(checkerTypeAt(l, node)), b);
    const binding: ?*const HType = if (node.data == .identifier) b.get(node.data.identifier) else null;
    const narrowed = if (binding != null and binding.?.* == .unknown and !narrowing.isCheckable(t)) binding.? else t;
    return renameShadowedClass(l, node, normalizeClassInstance(l, node, narrowed, b));
}

fn renameShadowedClass(l: *Lower, node: *Node, t: *const HType) *const HType {
    if (t.* != .object) return t;
    const declaration = gt.classLikeOf(l.g.typeAt(node)) orelse return t;
    const hir = l.hirNameOf(declaration) orelse return t;
    const chain = gt.ancestry(l.g, declaration);
    const bases = l.a.alloc([]const u8, t.object.bases.len) catch c.oom();
    var same = c.eql(hir, t.object.name);
    for (t.object.bases, bases) |base, *slot| {
        slot.* = base;
        for (chain) |candidate| {
            const name = candidate.data.class.name orelse continue;
            if (!c.eql(api.text(name) orelse "", base)) continue;
            slot.* = l.hirNameOf(candidate) orelse base;
            break;
        }
        same = same and c.eql(slot.*, base);
    }
    if (same) return t;
    var copy = t.*;
    copy.object.name = hir;
    copy.object.bases = bases;
    return l.create(copy);
}

const TupleLookup = struct {
    context: BoundParameters,
    parameters: []const *Node,
    tuple: []const *const HType,

    pub fn lookup(s: TupleLookup, name: []const u8) ?*const HType {
        for (s.parameters, 0..) |p, i| {
            if (c.eql(api.text(p.data.type_param.name) orelse "", name)) return s.tuple[i];
        }
        return s.context.lookup(name);
    }
};

pub fn normalizeClassInstance(l: *Lower, node: *Node, t: *const HType, b: *Scope) *const HType {
    if (t.* != .object) return t;
    const ts_type = l.g.typeAt(node);
    const declaration = api.valueDeclaration(api.typeSymbol(ts_type)) orelse return t;
    if (declaration.data != .class or declaration.data.class.is_expr or !specialize.isGenericClass(declaration)) return t;
    const tuple = members.classTupleFor(l, declaration, ts_type, b) orelse return t;
    const lookup: TupleLookup = .{ .context = .{ .l = l, .b = b }, .parameters = specialize.typeParameters(declaration), .tuple = tuple };
    const own_name = if (declaration.data.class.name) |n| api.text(n) orelse "" else "";
    var copy = t.*;
    copy.object.name = H.specializationName(l.a, own_name, tuple) catch c.oom();
    copy.object.fields = substituteFields(l, t.object.fields, lookup);
    copy.object.methods = substituteFields(l, t.object.methods, lookup);
    return l.create(copy);
}

pub fn substituteFields(l: *Lower, fields: []const c.HField, lookup: anytype) []const c.HField {
    const out = l.a.alloc(c.HField, fields.len) catch c.oom();
    for (fields, out) |field, *slot| {
        slot.* = field;
        slot.type = H.substituteHType(l.a, field.type, lookup) catch c.oom();
    }
    return out;
}

pub fn emptyArrayContextType(l: *Lower, node: *Node) ?*const HType {
    return arrays.emptyArrayContextType(l, node, null);
}

// An operator's token and its compound-assignment token share a row, so the two cannot drift.
const binary_tokens = [_]struct { c.Tok, ?c.Tok, N.BinaryOperator }{
    .{ .plus, .plus_assign, .@"+" },   .{ .minus, .minus_assign, .@"-" },     .{ .star, .star_assign, .@"*" },
    .{ .slash, .slash_assign, .@"/" }, .{ .percent, .percent_assign, .@"%" }, .{ .star2, .star2_assign, .@"**" },
    .{ .amp, .amp_assign, .@"&" },     .{ .pipe, .pipe_assign, .@"|" },       .{ .caret, .caret_assign, .@"^" },
    .{ .shl, .shl_assign, .@"<<" },    .{ .shr, .shr_assign, .@">>" },        .{ .ushr, .ushr_assign, .@">>>" },
    .{ .lt, null, .@"<" },             .{ .gt, null, .@">" },                 .{ .lte, null, .@"<=" },
    .{ .gte, null, .@">=" },           .{ .eq3, null, .@"===" },              .{ .neq3, null, .@"!==" },
    .{ .eq2, null, .@"==" },           .{ .neq, null, .@"!=" },               .{ .comma, null, .@"," },
    .{ .kw_in, null, .in },
};
const logical_tokens = [_]struct { c.Tok, ?c.Tok, N.LogicalOperator }{
    .{ .amp2, .amp2_assign, .@"&&" }, .{ .pipe2, .pipe2_assign, .@"||" }, .{ .qq, .qq_assign, .@"??" },
};

fn tokenOperator(comptime rows: anytype, comptime column: usize, op: c.Tok) ?@TypeOf(rows[0][2]) {
    inline for (rows) |row| if (row[column] == op) return row[2];
    return null;
}

fn binaryOperator(op: c.Tok) ?N.BinaryOperator {
    return tokenOperator(binary_tokens, 0, op);
}

fn logicalOperator(op: c.Tok) ?N.LogicalOperator {
    return tokenOperator(logical_tokens, 0, op);
}

pub fn compoundOperator(op: c.Tok) ?N.BinaryOperator {
    return tokenOperator(binary_tokens, 1, op);
}

pub fn logicalAssignOperator(op: c.Tok) ?N.LogicalOperator {
    return tokenOperator(logical_tokens, 1, op);
}

fn unaryOperator(op: c.Tok) ?N.UnaryOperator {
    return switch (op) {
        .minus => .@"-",
        .plus => .@"+",
        .bang => .@"!",
        .tilde => .@"~",
        .kw_void => .void,
        else => null,
    };
}

fn stripParens(node: *Node) *Node {
    return api.skipParens(node);
}

fn isChainLink(node: *const Node) bool {
    return node.data == .prop_access or node.data == .elem_access or node.data == .call;
}

fn chainExpression(node: *const Node) *Node {
    return node_field.of(*Node, node, .{ .{ .prop_access, "expr" }, .{ .elem_access, "expr" }, .{ .call, "callee" } }).?;
}

fn isOptionalLink(node: *const Node) bool {
    return node_field.of(bool, node, .{ .{ .prop_access, "optional" }, .{ .elem_access, "optional" }, .{ .call, "optional" } }) orelse false;
}

fn firstOptionalLink(node: *Node) ?*Node {
    var current = node;
    while (true) {
        if (isChainLink(current)) {
            if (isOptionalLink(current)) return current;
            current = chainExpression(current);
        } else if (current.data == .non_null) {
            current = current.data.non_null.expr;
        } else return null;
    }
}

fn lowerOptionalChain(l: *Lower, node: *Node, link: *Node, b: *Scope) E!Expression {
    const span = l.span(node);
    const prefix = chainExpression(link);
    if (!H.hTypeCanBeNullish(typeAt(l, prefix, b))) return lowerChain(l, node, b, true);
    const base = try lowerExpression(l, prefix, b);
    const previous = l.optional_chain_cuts.get(prefix);
    l.optional_chain_cuts.put(l.a, prefix, base.getType()) catch c.oom();
    const consequent = lowerChain(l, node, b, true);
    if (previous) |p| l.optional_chain_cuts.put(l.a, prefix, p) catch c.oom() else _ = l.optional_chain_cuts.remove(prefix);
    return l.ex(.optional_chain, .{ .type = typeAt(l, node, b), .span = span, .base = base, .consequent = try consequent });
}

pub fn lowerExpression(l: *Lower, node: *Node, b: *Scope) E!Expression {
    return lowerChain(l, node, b, false);
}

fn lowerDelete(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const operand = stripParens(node.data.delete_expr.expr);
    const span = l.span(node);
    switch (operand.data) {
        .prop_access => |x| {
            const target = try lowerExpression(l, x.expr, b);
            const key = l.ex(.string_literal, .{ .type = H_STRING, .span = l.span(x.name), .value = api.text(x.name) orelse "" });
            return l.ex(.delete_prop, .{ .type = H_BOOLEAN, .span = span, .target = target, .key = key });
        },
        .elem_access => |x| {
            const target = try lowerExpression(l, x.expr, b);
            const key = try lowerExpression(l, x.index, b);
            return l.ex(.delete_prop, .{ .type = H_BOOLEAN, .span = span, .target = target, .key = key });
        },
        else => return error.Refused,
    }
}

fn lowerChain(l: *Lower, node: *Node, b: *Scope, chain_bypass: bool) E!Expression {
    if (l.optional_chain_cuts.get(node)) |cut| return l.ex(.optional_base, .{ .type = cut, .span = l.span(node) });
    if (node.data == .paren) return lowerExpression(l, node.data.paren.expr, b);
    if (node.data == .prop_access and gate_globals.isSelfBoundCallApply(l.g, node) and typeAt(l, node.data.prop_access.expr, b).* == .array) {
        const target = try lowerExpression(l, node.data.prop_access.expr, b);
        return l.ex(.dyn_field_access, .{ .type = c.hUnknown(false), .span = l.span(node), .target = target, .field = members.propertyText(node) });
    }
    if (gate_globals.builtinValueOf(l.g, node)) |builtin| {
        const span = l.span(node);
        const name: N.GlobalCallName = switch (builtin.row) {
            .ctor => .@"%ctor",
            .proto => .@"%proto",
            .object_proto => .@"%objectProto",
        };
        return l.ex(.global_call, .{ .type = c.hUnknown(false), .span = span, .name = name, .args = l.dupe(Expression, &.{l.string(span, builtin.name)}) });
    }
    switch (node.data) {
        .delete_expr => return lowerDelete(l, node, b),
        .void_expr => |x| {
            const operand = try lowerExpression(l, x.expr, b);
            return l.ex(.unary_op, .{ .type = H_UNDEFINED, .span = l.span(node), .operator = .void, .operand = operand });
        },
        .conditional => |x| {
            const condition = lowerExpression(l, x.cond, b);
            const consequent = lowerExpression(l, x.then, b);
            const alternate = lowerExpression(l, x.els, b);
            return l.ex(.conditional, .{ .type = typeAt(l, node, b), .span = l.span(node), .condition = try condition, .consequent = try consequent, .alternate = try alternate });
        },
        else => {},
    }
    if (try assign.lowerUpdateExpression(l, node, b)) |update| return update;
    if (!chain_bypass and isChainLink(node)) {
        if (firstOptionalLink(node)) |link| return lowerOptionalChain(l, node, link, b);
    }
    switch (node.data) {
        .prefix => |x| if (x.op == .minus and x.expr.data == .numeric_lit) {
            return l.ex(.number_literal, .{ .type = typeAt(l, node, b), .span = l.span(node), .value = -(gt.parseNumber(x.expr.data.numeric_lit) orelse std.math.nan(f64)) });
        } else return lowerPrefix(l, node, b),
        .numeric_lit => |text| return l.ex(.number_literal, .{ .type = typeAt(l, node, b), .span = l.span(node), .value = gt.parseNumber(text) orelse std.math.nan(f64) }),
        .string_lit, .no_subst_template => |text| return l.ex(.string_literal, .{ .type = typeAt(l, node, b), .span = l.span(node), .value = text }),
        .regex_lit => |text| {
            const end = std.mem.lastIndexOfScalar(u8, text, '/') orelse 0;
            return l.ex(.regexp_literal, .{ .type = typeAt(l, node, b), .span = l.span(node), .source = text[1..end], .flags = text[end + 1 ..] });
        },
        .template_expr => return lowerTemplate(l, node, b),
        .prop_access => if (try lowerPropertyAccess(l, node, b)) |read| return read,
        .array_lit => return arrays.lowerArrayLiteralExpression(l, node, b),
        .elem_access => return lowerElementAccess(l, node, b),
        .true_lit, .false_lit => return l.ex(.boolean_literal, .{ .type = typeAt(l, node, b), .span = l.span(node), .value = node.data == .true_lit }),
        .this_expr => return members.receiverIdentifier(l, node, b),
        .object_lit => return objects.lowerObjectLiteral(l, node, b),
        .new_expr => return calls.lowerNew(l, node, b),
        .null_lit => return l.ex(.null_literal, .{ .type = typeAt(l, node, b), .span = l.span(node) }),
        .identifier => return lowerIdentifier(l, node, b),
        .typeof_expr => return lowerTypeof(l, node, b),
        .await_expr => |x| {
            if (l.function_nesting == 0) l.module_awaits = true;
            const value = try lowerExpression(l, x.expr, b);
            return l.ex(.await, .{ .type = typeAt(l, node, b), .span = l.span(node), .value = value });
        },
        .yield_expr => |x| {
            const span = l.span(node);
            const value = if (x.expr) |e| try lowerExpression(l, e, b) else l.undef(span);
            return l.ex(.yield, .{ .type = typeAt(l, node, b), .span = span, .value = value });
        },
        .satisfies_expr => |x| return lowerExpression(l, x.expr, b),
        .as_expr => |x| {
            const operand = try lowerExpression(l, x.expr, b);
            const asserted = narrowing.assertedBy(l.g, node) orelse return operand;
            if (!narrowing.isCheckable(asserted) or operand.getType().* != .unknown) return operand;
            return boundary.boundaryCheck(l, operand, asserted, node);
        },
        .binary => return lowerBinary(l, node, b),
        .func => |f| if (f.kind == .expr or f.kind == .arrow) return .{ .function = try functions.lowerFunction(l, node, b) },
        .call => return calls.lowerCall(l, node, b),
        else => {},
    }
    return l.internal(node, "STA4031", l.fmt("unexpected expression kind: {t}", .{node.data}));
}

fn lowerPrefix(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const x = node.data.prefix;
    const operator = unaryOperator(x.op) orelse return l.internal(node, "STA4036", l.fmt("unsupported unary operator: {t}", .{x.op}));
    const operand = try lowerExpression(l, x.expr, b);
    return l.ex(.unary_op, .{ .type = typeAt(l, node, b), .span = l.span(node), .operator = operator, .operand = operand });
}

fn lowerTemplate(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const x = node.data.template_expr;
    var quasis: std.ArrayList([]const u8) = .empty;
    var values: c.ExprList = .empty;
    l.push(&quasis, x.head);
    for (x.spans) |span_node| {
        const s = span_node.data.template_span;
        const value = try lowerExpression(l, s.expr, b);
        l.push(&values, calls.userConversion(l, s.expr, value, "toString", b));
        l.push(&quasis, s.text);
    }
    return l.ex(.template_literal, .{ .type = typeAt(l, node, b), .span = l.span(node), .quasis = quasis.items, .expressions = values.items });
}

fn lowerPropertyAccess(l: *Lower, node: *Node, b: *Scope) E!?Expression {
    if (members.namespaceMemberRead(l, node, b)) |member| return member;
    const x = node.data.prop_access;
    const name = members.propertyText(node);
    if (c.eql(name, "value")) if (try lowerOutGet(l, x.expr, node, b)) |read| return read;
    if (gt.staticMemberOf(l.g, node, null)) |found| if (gt.classDisplayName(found.owner) != null) {
        if (members.isAccessorMember(found.member)) return try members.staticAccessorCall(l, .get, members.hirClassName(l, found.owner), name, &.{}, typeAt(l, node, b), l.span(node), node, b);
        const static_name = members.staticName(l, members.hirClassName(l, found.owner), name);
        const t = b.get(static_name) orelse return l.internal(node, "STA4066", l.fmt("static '{s}' read before its class declaration was lowered", .{static_name}));
        return l.ident(t, l.span(node), static_name);
    };
    if (gate_globals.isGlobalMath(l.g, x.expr)) if (gate_globals.mathConstant(name)) |value| return l.number(l.span(node), value);
    if (gate_globals.numberConstant(l.g, node)) |value| return l.number(l.span(node), value);
    if (c.eql(name, "name")) if (members.classObjectOwner(l, x.expr)) |owner| if (gt.classDisplayName(owner)) |display| {
        return l.string(l.span(node), if (c.eql(display, module_names.DEFAULT_EXPORT_BINDING)) "default" else display);
    };
    if (x.optional and x.name.data != .private_name and l.optional_chain_cuts.contains(x.expr)) {
        if (calls.nullableMethodInfo(l, x.expr, name, b)) |info| {
            const raw = try lowerExpression(l, x.expr, b);
            const target = l.ex(.optional_base, .{ .type = info.object_type, .span = raw.getSpan() });
            return l.ex(.method_value, .{ .type = typeAt(l, node, b), .span = l.span(node), .target = target, .class_name = info.class_name, .method = name, .slot = info.slot, .dispatch = info.dispatch });
        }
    }
    const receiver_kind = typeAt(l, x.expr, b);
    if (receiver_kind.* == .uint8array or receiver_kind.* == .arraybuffer) {
        const typed: N.TypedReceiver = if (receiver_kind.* == .uint8array) .uint8array else .arraybuffer;
        if (N.typedMember(typed, name)) |op| if (N.TYPED_OPS.get(op).form == .get) {
            const target = try lowerExpression(l, x.expr, b);
            return calls.typedOpNode(l, op, target, &.{}, l.span(node));
        };
    }
    if (!gate_member.isMatchReceiver(l.g, x.expr) and (members.targetIsDynamic(l, x.expr, b) or gt.isFunctionValueMember(l.g, x.expr, name) or gt.isUndeclaredMemberRead(l.g, node))) {
        const target = try lowerExpression(l, x.expr, b);
        return l.ex(.dyn_field_access, .{ .type = c.hUnknown(false), .span = l.span(node), .target = target, .field = name });
    }
    if (x.expr.data == .super_expr) {
        const target = try members.receiverIdentifier(l, x.expr, b);
        if (target.getType().* != .object) return l.internal(node, "STA4049", "receiver is not an object");
        if (x.name.data == .private_name) return l.internal(node, "STA4067", l.fmt("private '{s}' has no method value the lowering can reach", .{name}));
        const owner = members.declaringClassName(l, x.expr, name, b) orelse return l.internal(node, "STA4067", l.fmt("method '{s}' names no class the lowering can reach", .{name}));
        return try calls.methodValue(l, node, target, target.getType(), name, owner, false, b);
    }
    if (members.isClassInstance(l, x.expr, b)) {
        const target = try lowerExpression(l, x.expr, b);
        if (x.name.data == .private_name) {
            const priv = members.privateUse(l, x.name) orelse return l.internal(node, "STA4060", l.fmt("no private '{s}' the gate accepted", .{name}));
            return try members.lowerPrivateRead(l, priv, node, target, b);
        }
        return try calls.lowerClassMemberRead(l, target, name, x.expr, node, b);
    }
    if (c.eql(name, "size")) {
        const target = try lowerExpression(l, x.expr, b);
        const t = target.getType();
        if (t.* == .map or t.* == .set) {
            return l.ex(.collection_op, .{ .type = H_NUMBER, .span = l.span(node), .collection = if (t.* == .map) .map else .set, .op = .size, .target = target, .args = &.{} });
        }
    }
    if (gate_member.isMatchReceiver(l.g, x.expr)) if (std.meta.stringToEnum(N.MatchField, name)) |field| {
        return try fieldRead(l, .match_read, field, N.MATCH_FIELDS.get(field), c.hUnknown(false), node, b);
    };
    if (gate_member.isRegExpReceiver(l.g, x.expr)) if (std.meta.stringToEnum(N.RegExpField, name)) |field| {
        return try fieldRead(l, .regexp_read, field, N.REGEXP_FIELDS.get(field).result, H_BOOLEAN, node, b);
    };
    if (c.eql(name, "length")) {
        const operand = try lowerExpression(l, x.expr, b);
        return @import("patterns.zig").lengthRead(l, operand, l.span(node));
    }
    return null;
}

/// A built-in field read whose result is a number, a string, or the field table's other type.
fn fieldRead(l: *Lower, comptime kind: std.meta.Tag(Expression), field: anytype, result: anytype, other: *const HType, node: *Node, b: *Scope) E!Expression {
    const target = try lowerExpression(l, node.data.prop_access.expr, b);
    const t = switch (result) {
        .number => H_NUMBER,
        .string => H_STRING,
        else => other,
    };
    return l.ex(kind, .{ .type = t, .span = l.span(node), .field = field, .target = target });
}

fn lowerOutGet(l: *Lower, receiver: *Node, at: *Node, b: *Scope) E!?Expression {
    const inner = gt.outSlotInner(l.g, l.g.typeAt(receiver)) orelse return null;
    const operand = try lowerExpression(l, receiver, b);
    return l.ex(.out_get, .{ .type = c.hUnknown(false), .span = l.span(at), .operand = operand, .inner = if (gt.isBrandedPointer(l.g, inner)) .pointer else .cstring });
}

fn lowerElementAccess(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const x = node.data.elem_access;
    const key = gt.elementStaticKey(l.g, x.index);
    if (key) |k| if (c.eql(k, "value")) if (try lowerOutGet(l, x.expr, node, b)) |read| return read;
    if (gt.isSymbolIteratorKey(l.g, x.index)) {
        const target = try lowerExpression(l, x.expr, b);
        if (target.getType().* == .object and gt.userIteratorMethod(target.getType()) != null) {
            return calls.lowerClassMemberRead(l, target, gt.iterator_method_name, x.expr, node, b);
        }
    }
    if (key) |k| {
        const target = try lowerExpression(l, x.expr, b);
        if (target.getType().* == .object and members.declaresMember(l, target.getType(), k)) {
            return calls.lowerClassMemberRead(l, target, k, x.expr, node, b);
        }
    }
    return assign.lowerIndexAccess(l, node, b);
}

fn lowerIdentifier(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const name = node.data.identifier;
    const binding = b.get(name);
    const span = l.span(node);
    if (binding == null and c.eql(name, "undefined")) return l.undef(span);
    if (binding == null and c.eql(name, "NaN")) return l.number(span, std.math.nan(f64));
    if (binding == null and c.eql(name, "Infinity")) return l.number(span, std.math.inf(f64));
    if (try specialize.canonicalValueReference(l, node, b)) |canonical| return canonical;
    const t = binding orelse {
        if (assign.isUnresolvableIdentifier(l, node, b)) return l.ex(.reference_error, .{ .type = c.hUnknown(false), .span = span, .name = name });
        return l.internal(node, "STA4035", l.fmt("identifier '{s}' used before declaration", .{name}));
    };
    const ident = l.ident(t, span, b.hirName(name));
    if (narrowing.narrowedTo(l.g, node)) |narrowed| {
        if (narrowing.isCheckable(narrowed) and t.* == .unknown) return boundary.boundaryCheck(l, ident, narrowed, node);
    }
    return ident;
}

fn lowerTypeof(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const operand_node = stripParens(node.data.typeof_expr.expr);
    const span = l.span(node);
    if (operand_node.data == .identifier) {
        if (gate_generics.genericValueInstantiation(l.g, operand_node) or members.classObjectOwner(l, operand_node) != null) return l.string(span, "function");
        if (gate_globals.globalTypeofAnswer(l.g, operand_node)) |answer| return l.string(span, answer);
        if (assign.isUnresolvableIdentifier(l, operand_node, b)) return l.string(span, "undefined");
    }
    const operand = try lowerExpression(l, node.data.typeof_expr.expr, b);
    return l.ex(.typeof, .{ .type = H_STRING, .span = span, .operand = operand });
}

fn instanceofClass(l: *Lower, right: *Node) ?*Node {
    if (l.g.symbolAt(right)) |symbol| if (api.valueDeclaration(symbol)) |direct| {
        if (direct.data == .class) return direct;
    };
    if (right.data != .identifier) return null;
    return gt.aliasedClassDeclaration(l.g, right) orelse gt.classExpressionTarget(l.g, right) orelse gt.innerClassExpression(l.g, right);
}

fn lowerBinary(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const x = node.data.binary;
    if (x.op == .kw_in and x.left.data == .private_name) {
        const span = l.span(node);
        const target = try lowerExpression(l, x.right, b);
        const owner = gate_ops.brandDeclaringClass(x.left) orelse return l.internal(x.left, "STA4073", "the #brand-in-object test names no class the gate accepted");
        return l.ex(.instanceof, .{ .type = H_BOOLEAN, .span = span, .target = target, .class_name = members.hirClassName(l, owner) });
    }
    if (x.op == .kw_instanceof) {
        const span = l.span(node);
        const target = try lowerExpression(l, x.left, b);
        if (x.right.data == .identifier and gate_core.isInstanceofBuiltin(x.right.data.identifier)) {
            return l.ex(.instanceof, .{ .type = H_BOOLEAN, .span = span, .target = target, .class_name = x.right.data.identifier, .builtin = true });
        }
        if (gt.isFunctionValueCallee(l.g, x.right)) {
            const ctor = try lowerExpression(l, x.right, b);
            return l.ex(.instanceof_value, .{ .type = H_BOOLEAN, .span = span, .target = target, .ctor = ctor });
        }
        const declaration = instanceofClass(l, x.right);
        if (declaration == null or gt.classDisplayName(declaration.?) == null) return l.internal(x.right, "STA4063", "instanceof right operand is not a class the gate accepted");
        return l.ex(.instanceof, .{ .type = H_BOOLEAN, .span = span, .target = target, .class_name = members.hirClassName(l, declaration.?) });
    }
    const operator = binaryOperator(x.op);
    const logical = logicalOperator(x.op);
    if (operator == null and logical == null) return l.internal(node, "STA4036", l.fmt("unsupported binary operator: {t}", .{x.op}));
    const left = try lowerExpression(l, x.left, b);
    const right = try lowerExpression(l, x.right, b);
    const t = typeAt(l, node, b);
    const span = l.span(node);
    if (logical) |op| return l.ex(.logical_op, .{ .type = t, .span = span, .operator = op, .left = left, .right = right });
    const op = operator.?;
    if (op == .@",") return l.ex(.binary_op, .{ .type = right.getType(), .span = span, .operator = op, .left = left, .right = right });
    if (op == .@"+") {
        return c.arithmeticBinOp(l, op, calls.userConversion(l, x.left, left, "valueOf", b), calls.userConversion(l, x.right, right, "valueOf", b), span, t);
    }
    return c.arithmeticBinOp(l, op, left, right, span, t);
}
