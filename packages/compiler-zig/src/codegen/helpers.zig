//! Shared pure helpers for the C emitter, with no emitter state. Mirrors the HIR half of
//! `packages/compiler/src/codegen/helpers.ts`; the string half is `literals.zig`.

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("../hir/nodes.zig");
const types = @import("../hir/types.zig");
const literals = @import("literals.zig");
const tables = @import("tables.zig");

const HType = types.HType;
const HField = types.HField;
const Expression = nodes.Expression;
const Span = nodes.Span;
const hTypeConversionRunsUserCode = types.hTypeConversionRunsUserCode;

/// A parameter name no source can spell; a method's receiver travels under it.
pub const receiver_name = " this";

pub fn unaryConverts(expr: *const nodes.UnaryOp) bool {
    return (expr.operator == .@"+" or expr.operator == .@"-" or expr.operator == .@"~") and
        hTypeConversionRunsUserCode(expr.operand.getType());
}

/// `+=` converts inside `jsrt_op_add`, in order, and needs no help (§13.15.2).
pub fn compoundConverts(expr: *const nodes.UpdateExpr) bool {
    const value = expr.value orelse return false;
    const operator = updateAsBinary(expr.operator) orelse return false;
    return tables.isNumericBinaryOperator(operator) and
        (hTypeConversionRunsUserCode(expr.target.expression().getType()) or
            hTypeConversionRunsUserCode(value.getType()));
}

/// The binary operator a compound assignment applies, or null for `=`, `++`, `--` and the
/// short-circuit forms, none of which is a BinaryOp.
pub fn updateAsBinary(operator: nodes.UpdateOperator) ?nodes.BinaryOperator {
    return std.meta.stringToEnum(nodes.BinaryOperator, @tagName(operator));
}

pub fn argsConvert(args: []const Expression) bool {
    for (args) |arg| {
        if (hTypeConversionRunsUserCode(arg.getType())) return true;
    }
    return false;
}

pub fn declaredArity(params: []const nodes.Parameter) usize {
    var n: usize = 0;
    for (params) |param| {
        if (param.rest == true or param.default != null) break;
        n += 1;
    }
    return n;
}

pub const ClosureMeta = struct { arity: usize, has_receiver: bool };

pub fn closureMeta(function: *const nodes.FunctionExpr) ClosureMeta {
    const params = function.params;
    const has_receiver = params.len > 0 and std.mem.eql(u8, params[0].name, receiver_name);
    return .{
        .arity = declaredArity(if (has_receiver) params[1..] else params),
        .has_receiver = has_receiver,
    };
}

/// Null when the literal's type is not an object, which lowering never produces.
pub fn shapeOf(expr: *const nodes.ObjectLiteral) ?*const types.HObject {
    return if (expr.type.* == .object) &expr.type.object else null;
}

/// Slot indices in written key order, or null when that IS slot order. A duplicate key keeps its
/// first position and its single slot (§13.2.5.5).
pub fn keyOrderOf(arena: Allocator, expr: *const nodes.ObjectLiteral, layout: []const HField) Allocator.Error!?[]const usize {
    var order: std.ArrayList(usize) = .empty;
    for (expr.entries) |entry| {
        for (layout, 0..) |field, slot| {
            if (!std.mem.eql(u8, field.name, entry.name)) continue;
            if (std.mem.indexOfScalar(usize, order.items, slot) == null) try order.append(arena, slot);
            break;
        }
    }
    var identity = true;
    for (order.items, 0..) |slot, i| {
        if (slot != i) identity = false;
    }
    if (order.items.len != layout.len or identity) return null;
    return order.items;
}

pub fn dynLiteralBaseSlots(expr: *const nodes.DynObjectLiteral) usize {
    if (expr.entries.len == 0) return 1;
    var stores_value = false;
    var wide = false;
    for (expr.entries) |entry| {
        switch (entry) {
            .accessor_entry => |accessor| {
                stores_value = true;
                if (accessor.get != null and accessor.set != null) wide = true;
            },
            .computed_entry => wide = true,
            .object_entry => |object| {
                if (object.spread != true) stores_value = true;
            },
        }
    }
    if (wide) return 3;
    return if (stores_value) 2 else 1;
}

/// The span, not node identity, because the passes rebuild a spread's shared source subtree into
/// structurally-equal copies while no pass synthesizes a span.
pub fn spreadScratchKey(arena: Allocator, span: Span) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(arena, "{s}:{d}:{d}", .{ span.file orelse "", span.start, span.length });
}

pub const SpreadGroup = struct { key: []const u8, target: Expression };

const GroupCollector = struct {
    arena: Allocator,
    seen: std.StringArrayHashMapUnmanaged(void) = .empty,
    out: std.ArrayList(SpreadGroup) = .empty,

    fn claim(self: *GroupCollector, key: []const u8, target: Expression) Allocator.Error!void {
        const slot = try self.seen.getOrPut(self.arena, key);
        if (!slot.found_existing) try self.out.append(self.arena, .{ .key = key, .target = target });
    }

    fn scratch(self: *GroupCollector, span: Span, target: Expression) Allocator.Error!void {
        if (target == .identifier) return;
        try self.claim(try spreadScratchKey(self.arena, span), target);
    }

    fn scratchValue(self: *GroupCollector, value: Expression) Allocator.Error!void {
        switch (value) {
            .field_access => |access| try self.scratch(access.span, access.target),
            .method_value => |method| try self.scratch(method.span, method.target),
            else => {},
        }
    }
};

/// One rooted scratch per spread fragment with a non-trivial source, in first-occurrence order.
/// Counting and emission both call this, so the reserved slots and the written ones agree.
pub fn spreadScratches(arena: Allocator, entries: anytype, copies: []const nodes.MethodCopy) Allocator.Error![]const SpreadGroup {
    var collector: GroupCollector = .{ .arena = arena };
    for (entries) |entry| {
        const object = objectEntry(entry) orelse continue;
        if (object.spread == true) try collector.scratchValue(object.value);
    }
    for (copies) |copy| try collector.scratchValue(.{ .method_value = copy.value });
    return collector.out.items;
}

/// The identifier-source fragments, which the order repair snapshots: a suspension may intervene
/// and a later entry may reassign the binding.
pub fn spreadSnapshots(arena: Allocator, entries: anytype) Allocator.Error![]const SpreadGroup {
    var collector: GroupCollector = .{ .arena = arena };
    for (entries) |entry| {
        const object = objectEntry(entry) orelse continue;
        if (object.spread != true or object.value != .field_access) continue;
        const access = object.value.field_access;
        if (access.target != .identifier) continue;
        try collector.claim(try spreadScratchKey(arena, access.span), access.target);
    }
    return collector.out.items;
}

/// A static literal's entries and a dynamic literal's share these walks; only the latter may hold
/// accessor and computed entries, which no spread ever is.
pub fn objectEntry(entry: anytype) ?nodes.ObjectEntry {
    if (@TypeOf(entry) == nodes.ObjectEntry) return entry;
    return switch (entry) {
        .object_entry => |object| object,
        else => null,
    };
}

/// The `JSRT_ITER_*` kinds, numbered here because generated C spells them as numbers.
pub const iter_kinds = struct {
    pub const array = .{ .keys = 0, .values = 1, .entries = 2 };
    pub const map = .{ .keys = 3, .values = 4, .entries = 5 };
    pub const set = .{ .keys = 6, .values = 7, .entries = 8 };
    pub const matchAll = 9;
    pub const string = 10;
};

pub fn indexGetCall(arena: Allocator, target: *const HType, object: []const u8, index: []const u8) Allocator.Error![]const u8 {
    return switch (target.*) {
        .unknown, .string => std.fmt.allocPrint(arena, "jsrt_dyn_index_get({s}, {s}, NULL)", .{ object, index }),
        .uint8array => std.fmt.allocPrint(arena, "jsrt_uint8array_get({s}, {s})", .{ object, index }),
        else => std.fmt.allocPrint(arena, "jsrt_array_get({s}, {s})", .{ object, index }),
    };
}

/// Only an array whose element is Unknown may be made sparse: a typed element has no value that
/// could stand for a hole.
/// A call whose receiver sits in the rooted slot `receiver`, its `arg_count` arguments in the
/// slots after it: a method call, a constructor or an accessor. Never `jsrt_call` over the whole
/// run: that one takes no receiver, so `this` would become the first argument (plan-notes 395).
pub fn receiverCall(arena: Allocator, callee: []const u8, receiver: []const u8, arg_count: usize) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(arena, "jsrt_call_with_this({s}, {s}, {d}, &{s} + 1)", .{ callee, receiver, arg_count, receiver });
}

pub fn indexSetCall(arena: Allocator, target: *const HType, object: []const u8, index: []const u8, value: []const u8) Allocator.Error![]const u8 {
    return switch (target.*) {
        .unknown, .string => std.fmt.allocPrint(arena, "jsrt_dyn_index_set({s}, {s}, {s}, NULL)", .{ object, index, value }),
        .uint8array => std.fmt.allocPrint(arena, "jsrt_uint8array_put({s}, {s}, {s})", .{ object, index, value }),
        .array => |array| if (array.element.* == .unknown)
            std.fmt.allocPrint(arena, "jsrt_array_set_sparse({s}, {s}, {s})", .{ object, index, value })
        else
            std.fmt.allocPrint(arena, "jsrt_array_set({s}, {s}, {s})", .{ object, index, value }),
        else => std.fmt.allocPrint(arena, "jsrt_array_set({s}, {s}, {s})", .{ object, index, value }),
    };
}

/// A WeakMap is typed as a Map, so the KEY type decides (docs/VALUE.md §4.22).
pub fn mayRefuseWeakKey(expr: *const nodes.CollectionOp) bool {
    if (expr.op != .set and expr.op != .add) return false;
    const key: *const HType = switch (expr.target.getType().*) {
        .map => |map| map.key,
        .set => |set| set.element,
        else => return true,
    };
    return key.* == .unknown or key.* == .type_param;
}

const IterSource = enum { array, map, set };

fn iteratorKind(source: IterSource, op: []const u8) ?u32 {
    const offset: u32 = if (std.mem.eql(u8, op, "keys"))
        0
    else if (std.mem.eql(u8, op, "values"))
        1
    else if (std.mem.eql(u8, op, "entries"))
        2
    else
        return null;
    return @as(u32, switch (source) {
        .array => iter_kinds.array.keys,
        .map => iter_kinds.map.keys,
        .set => iter_kinds.set.keys,
    }) + offset;
}

pub fn arrayIteratorBoxCall(arena: Allocator, op: nodes.ArrayOpName, operands: []const u8) Allocator.Error!?[]const u8 {
    const kind = iteratorKind(.array, @tagName(op)) orelse return null;
    return try std.fmt.allocPrint(arena, "jsrt_iterator_new({s}, {d})", .{ operands, kind });
}

pub fn collectionIteratorBoxCall(arena: Allocator, collection: nodes.CollectionKind, op: nodes.CollectionOperation, operands: []const u8) Allocator.Error!?[]const u8 {
    const kind = iteratorKind(if (collection == .set) .set else .map, @tagName(op)) orelse return null;
    return try std.fmt.allocPrint(arena, "jsrt_iterator_new({s}, {d})", .{ operands, kind });
}

pub fn collectionCall(arena: Allocator, op: nodes.CollectionOperation, collection: nodes.CollectionKind, operands: []const u8) Allocator.Error![]const u8 {
    const f = std.fmt.allocPrint;
    return switch (op) {
        .get => f(arena, "jsrt_map_get({s})", .{operands}),
        .set => f(arena, "jsrt_map_set({s})", .{operands}),
        .add => f(arena, "jsrt_set_add({s})", .{operands}),
        .has => f(arena, "jsrt_bool(jsrt_map_has({s}))", .{operands}),
        .delete => f(arena, "jsrt_bool(jsrt_map_delete({s}))", .{operands}),
        .clear => f(arena, "jsrt_map_clear({s})", .{operands}),
        .size => f(arena, "jsrt_map_size({s})", .{operands}),
        .forEach => f(arena, "jsrt_{s}_for_each({s})", .{ @tagName(collection), operands }),
        .keys, .values, .entries => (try collectionIteratorBoxCall(arena, collection, op, operands)).?,
        inline else => |set_op| {
            const call = try f(arena, "jsrt_set_{s}({s})", .{ try literals.snakeCase(arena, @tagName(set_op)), operands });
            const name = std.meta.stringToEnum(nodes.SetOperation, @tagName(set_op)).?;
            return if (nodes.SET_OPS.get(name) == .boolean) f(arena, "jsrt_bool({s})", .{call}) else call;
        },
    };
}

const testing = std.testing;

test "the set operations follow the runtime's naming rule" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    try testing.expectEqualStrings("jsrt_set_union(a, b)", try collectionCall(arena, .@"union", .set, "a, b"));
    try testing.expectEqualStrings("jsrt_bool(jsrt_set_is_subset_of(a, b))", try collectionCall(arena, .isSubsetOf, .set, "a, b"));
    try testing.expectEqualStrings("jsrt_set_for_each(a)", try collectionCall(arena, .forEach, .set, "a"));
    try testing.expectEqualStrings("jsrt_iterator_new(a, 7)", try collectionCall(arena, .values, .set, "a"));
    try testing.expectEqualStrings("jsrt_iterator_new(a, 5)", try collectionCall(arena, .entries, .map, "a"));
    try testing.expect(try arrayIteratorBoxCall(arena, .push, "a") == null);
}

test "index calls answer by target type" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    try testing.expectEqualStrings("jsrt_dyn_index_get(o, i, NULL)", try indexGetCall(arena, types.H_STRING, "o", "i"));
    const sparse = try types.hArray(arena, types.hUnknown(false));
    try testing.expectEqualStrings("jsrt_array_set_sparse(o, i, v)", try indexSetCall(arena, sparse, "o", "i", "v"));
    const dense = try types.hArray(arena, types.H_NUMBER);
    try testing.expectEqualStrings("jsrt_array_set(o, i, v)", try indexSetCall(arena, dense, "o", "i", "v"));
}
