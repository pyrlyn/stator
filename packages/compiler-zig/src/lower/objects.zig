//! Object literals: a fixed shape when the checker can name one, a run of dynamic entries when it
//! cannot, and `Object.assign` folds where a spread forces entries to be written in sequence.
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
const api = c.api;
const gt = c.gt;
const expressions = @import("expressions.zig");
const functions = @import("functions.zig");
const members = @import("members.zig");
const lowerExpression = expressions.lowerExpression;

const Method = struct { at: u32, order: u32, node: *Node };
const Fragment = struct {
    order: u32,
    pushed_fields: bool,
    target_is_identifier: bool,
    methods: []const []const u8,
    fields: []const c.HField,
};
const Copy = struct { at: u32, order: u32, name: []const u8, value: *const N.MethodValue };
const Folded = struct { at: u32, order: u32, source: Expression, span: Span };

const State = struct {
    entries: std.ArrayList(N.DynEntry) = .empty,
    methods: std.ArrayList(Method) = .empty,
    fragments: std.ArrayList(Fragment) = .empty,
    copies: std.ArrayList(Copy) = .empty,
    folded: std.ArrayList(Folded) = .empty,
};

fn plain(name: []const u8, value: Expression) N.DynEntry {
    return .{ .object_entry = .{ .name = name, .value = value } };
}

fn collectSpread(l: *Lower, node: *Node, property: *Node, index: u32, s: *State, b: *Scope) E!void {
    const source = try lowerExpression(l, property.data.spread_assign.expr, b);
    const spread_span = l.span(property);
    const t = source.getType();
    const at: u32 = @intCast(s.entries.items.len);
    if (t.* == .array or (t.* != .object and gt.objectLiteralIsDynamic(l.g, node))) {
        l.push(&s.folded, Folded{ .at = at, .order = index, .source = source, .span = spread_span });
        return;
    }
    if (t.* == .unknown) return l.notYet(property, "an object spread of an unknown value is not yet supported");
    if (t.* != .object) return l.internal(property, "STA4068", "object spread of a value with no shape");
    for (t.object.fields, 0..) |field, slot| {
        if (std.mem.startsWith(u8, field.name, "#")) continue;
        const read = l.ex(.field_access, .{ .type = field.type, .span = spread_span, .target = source, .field = field.name, .slot = @intCast(slot) });
        l.push(&s.entries, N.DynEntry{ .object_entry = .{ .name = field.name, .value = read, .spread = true } });
    }
    const source_name = t.object.name;
    var copied: std.ArrayList([]const u8) = .empty;
    if (std.mem.startsWith(u8, source_name, "{")) {
        for (t.object.methods, 0..) |method, slot| {
            const read = l.ex(.method_value, .{
                .type = method.type,
                .span = spread_span,
                .target = source,
                .class_name = source_name,
                .method = method.name,
                .slot = @intCast(slot),
                .dispatch = members.dispatchOf(l, source_name, method.name),
            });
            l.push(&s.copies, Copy{ .at = at, .order = index, .name = method.name, .value = read.method_value });
            l.push(&copied, method.name);
        }
    }
    l.push(&s.fragments, Fragment{
        .order = index,
        .pushed_fields = s.entries.items.len > at,
        .target_is_identifier = source == .identifier,
        .methods = copied.items,
        .fields = t.object.fields,
    });
}

fn collectAccessor(l: *Lower, property: *Node, s: *State, b: *Scope) E!void {
    const name_node = api.declarationName(property) orelse return l.internal(property, "STA4068", "object literal accessor with a key that is not a name");
    const name = members.memberKey(l, name_node, .string_lit) orelse return l.internal(property, "STA4068", "object literal accessor with a key that is not a name");
    const lowered: Expression = .{ .function = try functions.lowerFunctionWith(l, property, b, c.hUnknown(false)) };
    const is_get = api.isGetAccessor(property);
    for (s.entries.items) |*entry| {
        if (entry.* != .accessor_entry or !c.eql(entry.accessor_entry.name, name)) continue;
        if (is_get) entry.accessor_entry.get = lowered else entry.accessor_entry.set = lowered;
        return;
    }
    l.push(&s.entries, N.DynEntry{ .accessor_entry = .{ .name = name, .get = if (is_get) lowered else null, .set = if (is_get) null else lowered } });
}

fn isProtoSetterName(name: *const Node) bool {
    return switch (name.data) {
        .identifier => |x| c.eql(x, "__proto__"),
        .string_lit => |x| c.eql(x, "__proto__"),
        else => false,
    };
}

fn collect(l: *Lower, node: *Node, s: *State, b: *Scope) E!void {
    for (node.data.object_lit.props, 0..) |property, i| {
        const index: u32 = @intCast(i);
        switch (property.data) {
            .shorthand_assign => |x| {
                const value = try lowerExpression(l, x.name, b);
                l.push(&s.entries, plain(x.name.data.identifier, value));
            },
            .spread_assign => try collectSpread(l, node, property, index, s, b),
            .func => |f| switch (f.kind) {
                .method => {
                    const name = f.name;
                    if (name == null or (name.?.data != .identifier and name.?.data != .string_lit)) return l.internal(property, "STA4068", "object literal method with a key that is not a name");
                    l.push(&s.methods, Method{ .at = @intCast(s.entries.items.len), .order = index, .node = property });
                },
                .getter, .setter => try collectAccessor(l, property, s, b),
                else => return l.internal(property, "STA4068", "object literal member is not a name/value pair"),
            },
            .property_assign => |x| {
                const value = try lowerExpression(l, x.value, b);
                if (gt.staticPropertyName(l.g, x.name)) |key| {
                    l.push(&s.entries, N.DynEntry{ .object_entry = .{ .name = key, .value = value, .proto_setter = if (isProtoSetterName(x.name)) true else null } });
                    continue;
                }
                if (x.name.data != .computed_name) return l.internal(property, "STA4068", "object literal member is not a name/value pair");
                const key = try lowerExpression(l, x.name.data.computed_name.expr, b);
                l.push(&s.entries, N.DynEntry{ .computed_entry = .{ .key = key, .value = value } });
            },
            else => return l.internal(property, "STA4068", "object literal member is not a name/value pair"),
        }
    }
}

fn assembleDynRun(l: *Lower, entries: []const N.DynEntry, methods: []const Method, span: Span, b: *Scope) E!Expression {
    var ordered: std.ArrayList(N.DynEntry) = .empty;
    var cursor: u32 = 0;
    for (methods) |method| {
        while (cursor < method.at) : (cursor += 1) l.push(&ordered, entries[cursor]);
        const lowered: Expression = .{ .function = try functions.lowerFunctionWith(l, method.node, b, c.hUnknown(false)) };
        l.push(&ordered, plain(members.memberFunctionName(l, method.node, null), lowered));
    }
    while (cursor < entries.len) : (cursor += 1) l.push(&ordered, entries[cursor]);
    return l.ex(.dyn_object_literal, .{ .type = c.hUnknown(false), .span = span, .entries = ordered.items });
}

fn assignNode(l: *Lower, target: Expression, source: Expression, at: Span) Expression {
    return l.ex(.object_static, .{ .type = c.hUnknown(false), .span = at, .method = .assign, .args = l.dupe(Expression, &.{ target, source }) });
}

fn foldRun(l: *Lower, folded: *?Expression, run: Expression) void {
    folded.* = if (folded.*) |x| assignNode(l, x, run, run.getSpan()) else run;
}

/// Methods in the half-open window of written order, renumbered to the run they land in.
fn windowed(l: *Lower, methods: []const Method, after: i64, before: ?u32, shift: u32) []const Method {
    var out: std.ArrayList(Method) = .empty;
    for (methods) |method| {
        if (@as(i64, method.order) <= after) continue;
        if (before) |limit| if (method.order >= limit) continue;
        var copy = method;
        copy.at -= shift;
        l.push(&out, copy);
    }
    return out.items;
}

fn foldedLiteral(l: *Lower, node: *Node, s: *const State, span: Span, b: *Scope) E!Expression {
    var folded: ?Expression = null;
    var run_start: u32 = 0;
    var run_start_order: i64 = -1;
    for (s.folded.items) |fragment| {
        const run_entries = s.entries.items[run_start..fragment.at];
        const run_methods = windowed(l, s.methods.items, run_start_order, fragment.order, run_start);
        run_start = fragment.at;
        run_start_order = fragment.order;
        if (run_entries.len > 0 or run_methods.len > 0) foldRun(l, &folded, try assembleDynRun(l, run_entries, run_methods, span, b));
        const base = folded orelse l.ex(.dyn_object_literal, .{ .type = c.hUnknown(false), .span = span, .entries = &.{} });
        folded = assignNode(l, base, fragment.source, fragment.span);
    }
    const tail_entries = s.entries.items[run_start..];
    const tail_methods = windowed(l, s.methods.items, run_start_order, null, run_start);
    if (tail_entries.len > 0 or tail_methods.len > 0) foldRun(l, &folded, try assembleDynRun(l, tail_entries, tail_methods, span, b));
    return folded orelse l.internal(node, "STA4068", "object literal with a folded spread folded to nothing");
}

fn writerOf(writers: *std.StringHashMapUnmanaged(u32), l: *Lower, name: []const u8, order: u32) void {
    const previous = writers.get(name);
    if (previous == null or order >= previous.?) writers.put(l.a, name, order) catch c.oom();
}

fn containsName(names: []const []const u8, name: []const u8) bool {
    for (names) |x| if (c.eql(x, name)) return true;
    return false;
}

fn spreadKeepsCopy(s: *const State, name: []const u8, order: u32) bool {
    for (s.fragments.items) |fragment| {
        if (fragment.order != order or !containsName(fragment.methods, name)) continue;
        return !fragment.pushed_fields and !fragment.target_is_identifier;
    }
    return false;
}

fn fixedLiteral(l: *Lower, node: *Node, s: *const State, span: Span, b: *Scope) E!Expression {
    const contextual = gt.layoutContextualType(l.g, node);
    const contextual_type: ?*const HType = if (contextual) |x| expressions.ground(l, l.toH(x), b) else null;
    const own = expressions.typeAt(l, node, b);
    const t = if (contextual_type != null and contextual_type.?.* == .object) contextual_type.? else own;
    if (t.* != .object) return l.internal(node, "STA4068", "object literal has no shape");
    var fixed: std.ArrayList(N.ObjectEntry) = .empty;
    for (s.entries.items) |entry| switch (entry) {
        .accessor_entry => return l.internal(node, "STA4068", "object literal with an accessor took the fixed-shape path"),
        .computed_entry => return l.internal(node, "STA4068", "object literal with a computed key took the fixed-shape path"),
        .object_entry => |x| l.push(&fixed, x),
    };
    var writers: std.StringHashMapUnmanaged(u32) = .empty;
    for (s.methods.items) |method| writerOf(&writers, l, members.memberFunctionName(l, method.node, null), method.order);
    for (s.fragments.items) |fragment| for (fragment.methods) |name| writerOf(&writers, l, name, fragment.order);
    for (s.fragments.items) |fragment| {
        if (fragment.methods.len > 0 and !H.objectFieldsPrefix(t.object.fields, fragment.fields)) {
            return l.internal(node, "STA4068", "object spread of a value with methods that does not preserve its field order");
        }
    }
    var copies: std.ArrayList(N.MethodCopy) = .empty;
    for (s.copies.items) |copy| {
        if (writers.get(copy.name) == copy.order or spreadKeepsCopy(s, copy.name, copy.order)) {
            l.push(&copies, N.MethodCopy{ .name = copy.name, .value = copy.value, .at = copy.at });
        }
    }
    var methods: std.ArrayList(N.ClassMethod) = .empty;
    for (s.methods.items) |method| {
        const name = members.memberFunctionName(l, method.node, null);
        if (writers.get(name) != method.order) continue;
        l.push(&methods, N.ClassMethod{ .name = name, .@"fn" = try functions.lowerFunctionWith(l, method.node, b, t) });
    }
    for (t.object.methods) |method| {
        var written = false;
        for (methods.items) |x| written = written or c.eql(x.name, method.name);
        for (copies.items) |x| written = written or c.eql(x.name, method.name);
        if (!written) return l.internal(node, "STA4068", l.fmt("object literal method '{s}' has no definition or spread source", .{method.name}));
    }
    return l.ex(.object_literal, .{ .type = t, .span = span, .entries = fixed.items, .methods = methods.items, .method_copies = copies.items });
}

pub fn lowerObjectLiteral(l: *Lower, node: *Node, b: *Scope) E!Expression {
    const span = l.span(node);
    var s: State = .{};
    try collect(l, node, &s, b);
    const dynamic = gt.objectLiteralIsDynamic(l.g, node);
    if (s.folded.items.len > 0) {
        if (!dynamic) return l.internal(node, "STA4068", "object literal with a folded spread took the fixed-shape path");
        return foldedLiteral(l, node, &s, span, b);
    }
    if (dynamic) return assembleDynRun(l, s.entries.items, s.methods.items, span, b);
    return fixedLiteral(l, node, &s, span, b);
}
