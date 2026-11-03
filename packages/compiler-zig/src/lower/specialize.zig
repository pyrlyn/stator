//! Monomorphization. A worklist per file names every instantiation before any body is lowered, so
//! each lowered use can look its specialization up instead of creating one.
const std = @import("std");
const c = @import("ctx.zig");
const Lower = c.Lower;
const Node = c.Node;
const Scope = c.Scope;
const Expression = c.Expression;
const Statement = c.Statement;
const HType = c.HType;
const E = c.E;
const H = c.H;
const api = c.api;
const gt = c.gt;
const expressions = @import("expressions.zig");
const functions = @import("functions.zig");
const members = @import("members.zig");
const generics = @import("../frontend/generics.zig");
const gate_extern = @import("../frontend/gate_extern.zig");
const Substitution = generics.Substitution;

const MAX_INSTANTIATION_DEPTH = 16;

pub const Specialization = struct {
    name: []const u8,
    key: []const u8,
    declaration: *Node,
    substitution: *const Substitution,
};

pub const ClassSpecialization = struct {
    name: []const u8,
    declaration: *Node,
    substitution: *const Substitution,
    statics_only: bool,
};

pub const Collected = struct {
    functions: []const Specialization,
    classes: []const ClassSpecialization,
};

pub fn typeParameters(declaration: *const Node) []const *Node {
    return switch (declaration.data) {
        .func => |x| x.type_params.items,
        .class => |x| x.type_params.items,
        else => &.{},
    };
}

pub fn isGenericDeclaration(node: *const Node) bool {
    return typeParameters(node).len > 0;
}

pub fn isGenericClass(node: *const Node) bool {
    return typeParameters(node).len > 0;
}

pub fn typeParameterKey(l: *Lower, name: []const u8) []const u8 {
    return l.fmt("<{s}>", .{name});
}

pub fn genericNamesakeOf(l: *Lower, shape_name: []const u8) ?*Node {
    for (members.classesIn(l, l.sf)) |candidate| {
        const name = candidate.data.class.name orelse continue;
        if (c.eql(api.text(name) orelse "", shape_name) and isGenericClass(candidate)) return candidate;
    }
    return null;
}

fn substitutedTypeArguments(l: *Lower, arguments: []const *const HType, substitution: *const Substitution) []const *const HType {
    const out = l.a.alloc(*const HType, arguments.len) catch c.oom();
    for (arguments, out) |t, *slot| slot.* = H.substituteHType(l.a, t, substitution) catch c.oom();
    return out;
}

fn hasAnyTypeParam(arguments: []const *const HType) bool {
    for (arguments) |t| if (H.hasTypeParam(t)) return true;
    return false;
}

fn nameList(l: *Lower, arguments: []const *const HType) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (arguments, 0..) |t, i| {
        if (i > 0) out.appendSlice(l.a, ",") catch c.oom();
        out.appendSlice(l.a, l.hTypeName(t)) catch c.oom();
    }
    return out.items;
}

const Item = struct { declaration: *Node, substitution: *const Substitution, depth: u32 };

const Collector = struct {
    l: *Lower,
    emitted: std.StringArrayHashMapUnmanaged(Specialization) = .empty,
    classes_emitted: std.StringArrayHashMapUnmanaged(ClassSpecialization) = .empty,
    queue: std.ArrayList(Item) = .empty,
    failed: bool = false,

    fn enqueue(s: *Collector, at: *const Node, subject: []const u8, key: []const u8, declaration: *Node, arguments: []const *const HType, substitution: *const Substitution, depth: u32) void {
        const l = s.l;
        if (hasAnyTypeParam(arguments)) {
            l.note(at, "STA4070", .internal, l.fmt("generic {s} still mentions a type parameter after substitution: {s}", .{ subject, nameList(l, arguments) }));
            s.failed = true;
            return;
        }
        const is_class = declaration.data == .class;
        const name = if (is_class) H.specializationName(l.a, key, arguments) catch c.oom() else l.functionSpecializationName(declaration, key, arguments);
        if (if (is_class) s.classes_emitted.contains(name) else s.emitted.contains(name)) return;
        if (depth > MAX_INSTANTIATION_DEPTH) {
            l.note(at, "STA2003", .@"error", l.fmt("generic instantiation is more than {d} deep at '{s}'; it does not terminate", .{ MAX_INSTANTIATION_DEPTH, name }));
            s.failed = true;
            return;
        }
        const substitution_for = l.create(Substitution{ .map = substitution.map.clone(l.a) catch c.oom() });
        for (typeParameters(declaration), 0..) |parameter, index| {
            if (index >= arguments.len) break;
            substitution_for.put(l.g, api.text(parameter.data.type_param.name) orelse "", arguments[index]);
        }
        if (is_class) {
            s.classes_emitted.put(l.a, name, .{ .name = name, .declaration = declaration, .substitution = substitution_for, .statics_only = false }) catch c.oom();
        } else {
            s.emitted.put(l.a, name, .{ .name = name, .key = key, .declaration = declaration, .substitution = substitution_for }) catch c.oom();
        }
        l.push(&s.queue, Item{ .declaration = declaration, .substitution = substitution_for, .depth = depth });
    }

    fn requestGeneric(s: *Collector, at: *const Node, subject: []const u8, found: generics.Generic, substitution: *const Substitution, depth: u32) void {
        s.enqueue(at, subject, found.key, found.declaration, substitutedTypeArguments(s.l, found.type_arguments, substitution), found.substitution, depth);
    }

    fn request(s: *Collector, call: *Node, substitution: *const Substitution, depth: u32) void {
        if (gate_extern.outSlotDeclarationOf(s.l.g, call) != null) return;
        const found = generics.genericCall(s.l.g, call) orelse return;
        s.requestGeneric(call, "call", found, substitution, depth);
    }

    fn requestClass(s: *Collector, created: *Node, substitution: *const Substitution, depth: u32) void {
        const found = generics.genericNewInstantiation(s.l.g, created) orelse return;
        const key = if (found.declaration.data.class.name) |n| api.text(n) orelse "" else "";
        s.enqueue(created, "construction", key, found.declaration, substitutedTypeArguments(s.l, found.type_arguments, substitution), found.substitution, depth);
    }

    fn requestArgument(s: *Collector, argument: *Node, outer_call: *Node, substitution: *const Substitution, depth: u32) void {
        if (generics.genericArgumentTuple(s.l.g, argument, outer_call)) |found| s.requestGeneric(argument, "argument", found, substitution, depth);
    }

    fn requestValue(s: *Collector, argument: *Node, outer_call: *Node, substitution: *const Substitution, depth: u32) void {
        if (argument.data != .identifier) return;
        if (generics.genericArgumentTuple(s.l.g, argument, outer_call) != null) return;
        if (generics.genericValue(s.l.g, argument)) |found| s.requestGeneric(argument, "value", found, substitution, depth);
    }

    fn walkCalls(s: *Collector, root: *Node, substitution: *const Substitution, depth: u32) void {
        var walk: Walk = .{ .s = s, .root = root, .substitution = substitution, .depth = depth };
        c.ast.forEachChild(root, &walk, Walk.visit);
    }
};

const Walk = struct {
    s: *Collector,
    root: *Node,
    substitution: *const Substitution,
    depth: u32,

    fn visit(w: *Walk, node: *Node) void {
        if (node != w.root and isGenericDefinition(node)) return;
        if (node.data == .call) {
            w.s.request(node, w.substitution, w.depth);
            for (api.nodes(node.data.call.args)) |argument| {
                if (argument.data == .spread_elem) continue;
                w.s.requestArgument(argument, node, w.substitution, w.depth);
                w.s.requestValue(argument, node, w.substitution, w.depth);
            }
        }
        if (node.data == .new_expr) w.s.requestClass(node, w.substitution, w.depth);
        c.ast.forEachChild(node, w, visit);
    }
};

fn isGenericDefinition(node: *const Node) bool {
    return switch (node.data) {
        .func => |x| (x.kind == .decl or x.kind == .expr or x.kind == .arrow) and x.type_params.items.len > 0,
        .class => |x| !x.is_expr and x.type_params.items.len > 0,
        else => false,
    };
}

pub fn collectSpecializations(l: *Lower, file: *c.File) E!Collected {
    var s: Collector = .{ .l = l };
    const none = l.create(Substitution{});
    for (file.root.data.source_file.stmts) |statement| {
        if (statement.data == .func and statement.data.func.kind == .decl and isGenericDeclaration(statement)) continue;
        if (statement.data == .class and !statement.data.class.is_expr and isGenericClass(statement)) continue;
        s.walkCalls(statement, none, 1);
    }
    for (members.classesIn(l, file)) |declaration| {
        if (declaration.data.class.name == null) continue;
        const base = gt.baseClassOf(l.g, declaration) orelse continue;
        if (base.data != .class or base.data.class.is_expr or base.data.class.name == null or !isGenericClass(base)) continue;
        const tuple = gt.heritageTuple(l.g, base, declaration) orelse continue;
        if (hasAnyTypeParam(tuple)) continue;
        const grounded = gt.heritageSubstitution(l.g, declaration, gt.ancestry(l.g, declaration));
        const substitution = l.create(Substitution{ .map = grounded.get(base) orelse .empty });
        s.enqueue(declaration, "construction", api.text(base.data.class.name.?) orelse "", base, tuple, substitution, 1);
    }
    var i: usize = 0;
    while (i < s.queue.items.len and !s.failed) : (i += 1) {
        const item = s.queue.items[i];
        s.walkCalls(item.declaration, item.substitution, item.depth + 1);
    }
    if (s.failed) return error.Refused;
    return .{ .functions = s.emitted.values(), .classes = s.classes_emitted.values() };
}

/// A specialization a dependency already emitted must not be emitted twice.
pub fn unbound(l: *Lower, comptime X: type, items: []const X, bindings: *Scope) []const X {
    var out: std.ArrayList(X) = .empty;
    for (items) |item| if (!bindings.has(item.name)) l.push(&out, item);
    return out.items;
}

pub fn specsOf(l: *Lower, specs: []const ClassSpecialization, node: *const Node) []const ClassSpecialization {
    var out: std.ArrayList(ClassSpecialization) = .empty;
    for (specs) |spec| if (spec.declaration == node) l.push(&out, spec);
    return out.items;
}

fn collectedSpecialization(l: *Lower, declaration: *Node, key: []const u8, arguments: []const *const HType, at: *const Node, what: []const u8, b: *Scope, spanned: *const Node) E!Expression {
    const out = l.a.alloc(*const HType, arguments.len) catch c.oom();
    for (arguments, out) |t, *slot| slot.* = expressions.ground(l, t, b);
    const name = l.functionSpecializationName(declaration, key, out);
    const t = b.get(name) orelse return l.internal(at, "STA4070", l.fmt("no specialization '{s}' was collected for this {s}", .{ name, what }));
    return l.ident(t, l.span(spanned), name);
}

pub fn specializedCallee(l: *Lower, node: *Node, b: *Scope) E!?Expression {
    const found = generics.genericCall(l.g, node) orelse return null;
    return try collectedSpecialization(l, found.declaration, found.key, found.type_arguments, node, "call", b, node.data.call.callee);
}

pub fn specializedClassName(l: *Lower, node: *Node, b: *Scope) E!?[]const u8 {
    const found = generics.genericNewInstantiation(l.g, node) orelse return null;
    const arguments = l.a.alloc(*const HType, found.type_arguments.len) catch c.oom();
    for (found.type_arguments, arguments) |t, *slot| slot.* = expressions.ground(l, t, b);
    if (hasAnyTypeParam(arguments)) {
        return l.internal(node, "STA4070", l.fmt("generic construction still mentions a type parameter after substitution: {s}", .{nameList(l, arguments)}));
    }
    const key = if (found.declaration.data.class.name) |n| api.text(n) orelse "" else "";
    const name = H.specializationName(l.a, key, arguments) catch c.oom();
    if (!b.has(name)) return l.internal(node, "STA4070", l.fmt("no specialization '{s}' was collected for this construction", .{name}));
    return name;
}

pub fn specializedArgument(l: *Lower, argument: *Node, outer_call: *Node, b: *Scope) E!?Expression {
    const found = generics.genericArgumentTuple(l.g, argument, outer_call) orelse return null;
    return try collectedSpecialization(l, found.declaration, found.key, found.type_arguments, argument, "argument", b, argument);
}

pub fn canonicalValueReference(l: *Lower, node: *Node, b: *Scope) E!?Expression {
    const parent = node.parent orelse return null;
    if (parent.data != .call or parent.data.call.callee == node) return null;
    if (generics.genericArgumentTuple(l.g, node, parent) != null) return null;
    const value = generics.genericValue(l.g, node) orelse return null;
    return try collectedSpecialization(l, value.declaration, value.key, value.type_arguments, node, "value", b, node);
}

pub fn specializationType(l: *Lower, spec: Specialization) *const HType {
    const declared = gt.tsTypeToHType(l.g, l.g.typeAt(spec.declaration));
    return H.substituteHType(l.a, declared, spec.substitution) catch c.oom();
}

pub fn bindSubstitution(l: *Lower, inner: *Scope, substitution: *const Substitution) void {
    var it = substitution.map.iterator();
    while (it.next()) |entry| inner.set(typeParameterKey(l, entry.key_ptr.*), entry.value_ptr.*);
}

pub fn lowerSpecialization(l: *Lower, spec: Specialization, b: *Scope) E!Statement {
    const inner = b.child();
    bindSubstitution(l, inner, spec.substitution);
    const saved = l.foreign;
    defer l.foreign = saved;
    const home = l.fileOfNode(spec.declaration);
    l.foreign = if (home != l.sf) home else null;
    const lowered = try functions.lowerFunction(l, spec.declaration, inner);
    const node = spec.declaration;
    const homeless = node.data.func.kind != .decl and @import("../frontend/gate_generics.zig").genericArrowKey(l.g, node) == null;
    var named = lowered;
    if (lowered.name == null and !homeless) {
        const copy = l.create(lowered.*);
        copy.name = generics.genericArrowPrintName(spec.key);
        named = copy;
    }
    return l.st(.function_declaration, .{ .type = c.H_UNDEFINED, .span = l.span(node), .name = spec.name, .@"fn" = named });
}
