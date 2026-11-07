//! HType: the type model everything below the frontend gate speaks. Mirrors
//! `packages/compiler/src/hir/types.ts`, which keeps the reasoning for each kind.
//!
//! A type is always handled as `*const HType`. The leaves are static singletons, so `hUnknown` and
//! the `H_*` constants never allocate; a compound type lives in the module's arena. Types may be
//! shared between nodes, which is why nothing here frees or compares by address.

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const HUnknown = struct { from_implicit_any: bool };

/// `params` is the declared list; it does not bound a call's argument count (JavaScript pads and
/// drops), so an emitter reads it as what to pad to, never as a contract the call site honoured.
pub const HFunction = struct {
    params: []const *const HType,
    ret: *const HType,
};

pub const HArray = struct { element: *const HType };
pub const HMap = struct { key: *const HType, value: *const HType };
pub const HSet = struct { element: *const HType };
pub const HIterator = struct { element: *const HType };
pub const HPromise = struct { value: *const HType };

/// The order of a field list is the slot order the emitter allocates, so it is part of the type.
pub const HField = struct {
    name: []const u8,
    type: *const HType,
};

/// Nominal: see `hTypeEquals`. `fields` already contains the inherited ones in the ancestors' slot
/// order; `bases` stays a name list so a cyclic class type is not a graph equality has to walk.
pub const HObject = struct {
    name: []const u8,
    fields: []const HField,
    methods: []const HField,
    bases: []const []const u8,
    namespace: ?bool = null,
};

pub const HTypeParam = struct { name: []const u8 };

/// Set when the value is an instance of a class extending `Uint8Array` (plan/T11.6a). Every element
/// read, `length` and extern `bytes` pass is still the view's, which is why the kind stays
/// `uint8array`; only the class's own methods, statics and `instanceof` need the name.
pub const HUint8Array = struct { subclass: ?ViewClass = null };

/// `bases` lists the user ancestors nearest first, as `HObject.bases` does, so assignability reads
/// the chain without the declarations. `methods` is what user classes in the chain declare, in
/// `HObject.methods`' order.
pub const ViewClass = struct {
    name: []const u8,
    bases: []const []const u8,
    methods: []const HField,
};

pub const HType = union(enum) {
    number,
    string,
    boolean,
    undefined,
    null,
    unknown: HUnknown,
    @"fn": HFunction,
    array: HArray,
    map: HMap,
    set: HSet,
    iterator: HIterator,
    regexp,
    date,
    uint8array: HUint8Array,
    arraybuffer,
    promise: HPromise,
    object: HObject,
    type_param: HTypeParam,
};

/// The payload-free kinds, each a static singleton. Built from the list so the `H_*` names stay
/// plain aliases of it.
const Leaf = enum { number, string, boolean, undefined, null, regexp, date, arraybuffer };
pub const leaf = leaves: {
    var all: std.enums.EnumFieldStruct(Leaf, *const HType, null) = undefined;
    for (std.meta.fieldNames(Leaf)) |name| @field(all, name) = &@unionInit(HType, name, {});
    break :leaves all;
};

pub const H_NUMBER = leaf.number;
pub const H_STRING = leaf.string;
pub const H_BOOLEAN = leaf.boolean;
pub const H_UNDEFINED = leaf.undefined;
pub const H_NULL = leaf.null;
pub const H_REGEXP = leaf.regexp;
pub const H_DATE = leaf.date;
/// A plain view: the subclass-free `uint8array`, a singleton like the leaves.
pub const H_UINT8ARRAY: *const HType = &.{ .uint8array = .{} };
pub const H_ARRAYBUFFER = leaf.arraybuffer;

const unknown_explicit: HType = .{ .unknown = .{ .from_implicit_any = false } };
const unknown_implicit: HType = .{ .unknown = .{ .from_implicit_any = true } };

pub fn hUnknown(from_implicit_any: bool) *const HType {
    return if (from_implicit_any) &unknown_implicit else &unknown_explicit;
}

fn make(arena: Allocator, value: HType) Allocator.Error!*const HType {
    const slot = try arena.create(HType);
    slot.* = value;
    return slot;
}

pub fn hFunction(arena: Allocator, params: []const *const HType, ret: *const HType) Allocator.Error!*const HType {
    return make(arena, .{ .@"fn" = .{ .params = params, .ret = ret } });
}

pub fn hMap(arena: Allocator, key: *const HType, value: *const HType) Allocator.Error!*const HType {
    return make(arena, .{ .map = .{ .key = key, .value = value } });
}

pub const hArray = Wrapper(.array).of;
pub const hSet = Wrapper(.set).of;
pub const hIterator = Wrapper(.iterator).of;
pub const hPromise = Wrapper(.promise).of;
pub const hTypeParam = Wrapper(.type_param).of;

/// The constructor of a kind whose payload is one field: it takes that field's value.
fn Wrapper(comptime kind: std.meta.Tag(HType)) type {
    const Payload = @FieldType(HType, @tagName(kind));
    const fields = std.meta.fieldNames(Payload);
    if (fields.len != 1) @compileError(@tagName(kind) ++ " has more than one field");
    return struct {
        fn of(arena: Allocator, value: @FieldType(Payload, fields[0])) Allocator.Error!*const HType {
            var payload: Payload = undefined;
            @field(payload, fields[0]) = value;
            return make(arena, @unionInit(HType, @tagName(kind), payload));
        }
    };
}

pub fn hObject(
    arena: Allocator,
    name: []const u8,
    fields: []const HField,
    methods: []const HField,
    bases: []const []const u8,
    namespace: ?bool,
) Allocator.Error!*const HType {
    return make(arena, .{ .object = .{
        .name = name,
        .fields = fields,
        .methods = methods,
        .bases = bases,
        .namespace = if (namespace == true) true else null,
    } });
}

pub const AccessorKind = enum { get, set };

/// A getter or setter is a method under a name no source can spell: the space does for an accessor
/// what the dot does for a static, so the mangled name can never collide with a real member.
pub fn accessorName(arena: Allocator, kind: AccessorKind, property: []const u8) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(arena, "{s} {s}", .{ @tagName(kind), property });
}

/// The inverse of `accessorName`, beside it so the two cannot drift.
pub fn accessorProperty(name: []const u8) ?[]const u8 {
    if (std.mem.startsWith(u8, name, "get ") or std.mem.startsWith(u8, name, "set ")) return name[4..];
    return null;
}

/// An index derived from anything but this list is an index into a layout nobody allocated.
pub fn fieldSlot(t: *const HObject, name: []const u8) ?usize {
    for (t.fields, 0..) |field, index| {
        if (std.mem.eql(u8, field.name, name)) return index;
    }
    return null;
}

/// A namespace is excluded: its fields are export slots read by name, not by offset. Shared by the
/// gate and the lowering, so the two admit exactly the same calls.
pub fn callableFieldSlot(t: *const HType, name: []const u8) ?usize {
    const object = switch (t.*) {
        .object => |*o| o,
        else => return null,
    };
    if (object.namespace == true) return null;
    const slot = fieldSlot(object, name) orelse return null;
    return switch (object.fields[slot].type.*) {
        .@"fn", .unknown => slot,
        else => null,
    };
}

/// The class layout a value's methods resolve against: the object itself, or, for an instance of a
/// `Uint8Array` subclass, a layout with no slots (the storage is the view's) and the class's
/// methods (plan/T11.6a). Every member-call path asks this rather than testing for `object`.
pub fn classLayoutOf(t: *const HType) ?HObject {
    return switch (t.*) {
        .object => |o| o,
        .uint8array => |u| if (u.subclass) |s| .{ .name = s.name, .fields = &.{}, .methods = s.methods, .bases = s.bases } else null,
        else => null,
    };
}

/// The view type of a `Uint8Array` subclass laid out as `layout`.
pub fn hViewClass(arena: Allocator, layout: HObject) Allocator.Error!*const HType {
    return make(arena, .{ .uint8array = .{ .subclass = .{ .name = layout.name, .bases = layout.bases, .methods = layout.methods } } });
}

pub fn methodOf(t: *const HObject, name: []const u8) ?*const HField {
    for (t.methods) |*method| {
        if (std.mem.eql(u8, method.name, name)) return method;
    }
    return null;
}

/// The spread-copy soundness rule rests on this alone: a copied method body reads `this` through
/// the source's layout, so the copy is sound exactly when the source's fields prefix the result's.
pub fn objectFieldsPrefix(whole: []const HField, sub: []const HField) bool {
    if (whole.len < sub.len) return false;
    for (sub, 0..) |field, index| {
        if (!std.mem.eql(u8, whole[index].name, field.name)) return false;
    }
    return true;
}

/// Identity, not assignability: parameter types compare invariantly. A pass that needs "can an `a`
/// be used where a `b` is expected" wants `hTypeAssignable`.
pub fn hTypeEquals(a: *const HType, b: *const HType) bool {
    if (std.meta.activeTag(a.*) != std.meta.activeTag(b.*)) return false;
    return switch (a.*) {
        .unknown => |x| x.from_implicit_any == b.unknown.from_implicit_any,
        .array => |x| hTypeEquals(x.element, b.array.element),
        .map => |x| hTypeEquals(x.key, b.map.key) and hTypeEquals(x.value, b.map.value),
        .set => |x| hTypeEquals(x.element, b.set.element),
        .iterator => |x| hTypeEquals(x.element, b.iterator.element),
        .promise => |x| hTypeEquals(x.value, b.promise.value),
        // By name: `class C { self: C }` is cyclic, and the only comparison that terminates on it
        // is the nominal one.
        .object => |x| std.mem.eql(u8, x.name, b.object.name),
        .type_param => |x| std.mem.eql(u8, x.name, b.type_param.name),
        .uint8array => |x| optionalEql(viewName(x), viewName(b.uint8array)),
        .@"fn" => |x| {
            const y = b.@"fn";
            if (x.params.len != y.params.len) return false;
            for (x.params, y.params) |p, q| {
                if (!hTypeEquals(p, q)) return false;
            }
            return hTypeEquals(x.ret, y.ret);
        },
        .number, .string, .boolean, .undefined, .null, .regexp, .date, .arraybuffer => true,
    };
}

fn viewName(t: HUint8Array) ?[]const u8 {
    return if (t.subclass) |s| s.name else null;
}

fn optionalEql(a: ?[]const u8, b: ?[]const u8) bool {
    if (a == null or b == null) return a == null and b == null;
    return std.mem.eql(u8, a.?, b.?);
}

/// Sound for classes only because a subclass's fields begin with its base's in the base's slot
/// order; the verifier's slot rule is what keeps that true.
pub fn hTypeAssignable(value: *const HType, target: *const HType) bool {
    // An Unknown value is a boxed jsrt_value stored by a total operation, and an Unknown target
    // promises nothing: the two directions are the same fact seen twice.
    if (value.* == .unknown or target.* == .unknown) return true;
    if (value.* == .object and target.* == .object) {
        return namedOrBase(value.object.name, value.object.bases, target.object.name);
    }
    // A subclass view goes where its ancestors' or a plain `Uint8Array` does, never back.
    if (value.* == .uint8array and target.* == .uint8array) {
        const want = viewName(target.uint8array) orelse return true;
        const have = value.uint8array.subclass orelse return false;
        return namedOrBase(have.name, have.bases, want);
    }
    // `unknown[]` is not kind unknown, and equality would reject two of them that differ only in
    // from_implicit_any, which is what `var xs = []` is after the hoist.
    if (value.* == .array and target.* == .array) {
        return hTypeAssignable(value.array.element, target.array.element);
    }
    return hTypeEquals(value, target);
}

fn namedOrBase(name: []const u8, bases: []const []const u8, want: []const u8) bool {
    if (std.mem.eql(u8, name, want)) return true;
    for (bases) |base| {
        if (std.mem.eql(u8, base, want)) return true;
    }
    return false;
}

/// `type_param` guards because no node should carry one: meeting one means something upstream
/// lied, and skipping the guard would trust it.
pub fn hTypeCanBeNullish(t: *const HType) bool {
    return switch (t.*) {
        .undefined, .null, .unknown, .type_param => true,
        else => false,
    };
}

/// Such a conversion can throw, so the emitter follows it with a pending check.
pub fn hTypeConversionRunsUserCode(t: *const HType) bool {
    return switch (t.*) {
        .object, .unknown, .type_param => true,
        .array => |a| hTypeConversionRunsUserCode(a.element),
        // A subclass may declare its own `toString` (Node's `Buffer` does).
        .uint8array => |u| u.subclass != null,
        .number,
        .string,
        .boolean,
        .undefined,
        .null,
        .@"fn",
        .map,
        .set,
        .iterator,
        .regexp,
        .date,
        .arraybuffer,
        .promise,
        => false,
    };
}

/// An object stops the walk for the reason equality does: the type can be cyclic, and a dynamic
/// field makes its READ dynamic, not the object value.
pub fn hTypeHasUnknown(t: *const HType) bool {
    return holds(t, .unknown);
}

/// A `true` in the verifier means a call was not specialized.
pub fn hasTypeParam(t: *const HType) bool {
    return holds(t, .type_param);
}

/// Whether `kind` occurs in `t` short of an object.
fn holds(t: *const HType, comptime kind: std.meta.Tag(HType)) bool {
    return switch (t.*) {
        kind => true,
        .array => |x| holds(x.element, kind),
        .set => |x| holds(x.element, kind),
        .iterator => |x| holds(x.element, kind),
        .map => |x| holds(x.key, kind) or holds(x.value, kind),
        .@"fn" => |x| {
            for (x.params) |p| {
                if (holds(p, kind)) return true;
            }
            return holds(x.ret, kind);
        },
        else => false,
    };
}

/// Diagnostic text, spelled the way TypeScript spells it so a Stator message and a tsc message
/// about the same value agree.
pub fn hTypeName(arena: Allocator, t: *const HType) Allocator.Error![]const u8 {
    return switch (t.*) {
        .object => |x| x.name,
        .type_param => |x| x.name,
        .array => |x| {
            const element = try hTypeName(arena, x.element);
            // `(() => number)[]` and `() => number[]` are different types.
            return if (x.element.* == .@"fn")
                std.fmt.allocPrint(arena, "({s})[]", .{element})
            else
                std.fmt.allocPrint(arena, "{s}[]", .{element});
        },
        .map => |x| std.fmt.allocPrint(arena, "Map<{s}, {s}>", .{ try hTypeName(arena, x.key), try hTypeName(arena, x.value) }),
        .set => |x| std.fmt.allocPrint(arena, "Set<{s}>", .{try hTypeName(arena, x.element)}),
        .iterator => |x| std.fmt.allocPrint(arena, "Iterator<{s}>", .{try hTypeName(arena, x.element)}),
        .promise => |x| std.fmt.allocPrint(arena, "Promise<{s}>", .{try hTypeName(arena, x.value)}),
        .@"fn" => |x| {
            var text: std.ArrayList(u8) = .empty;
            try text.append(arena, '(');
            for (x.params, 0..) |param, index| {
                if (index != 0) try text.appendSlice(arena, ", ");
                try text.print(arena, "a{d}: {s}", .{ index, try hTypeName(arena, param) });
            }
            try text.print(arena, ") => {s}", .{try hTypeName(arena, x.ret)});
            return text.items;
        },
        .regexp => "RegExp",
        .date => "Date",
        .uint8array => |u| viewName(u) orelse "Uint8Array",
        .arraybuffer => "ArrayBuffer",
        .number, .string, .boolean, .undefined, .null, .unknown => @tagName(t.*),
    };
}

/// A lookup rather than a map because the callers keep their substitutions where they already
/// thread them. An unbound name is left alone: the verifier refuses a type parameter, and a silent
/// Unknown would turn a missed substitution into a boxed value nobody asked for.
///
/// `context.lookup(name)` answers `?*const HType`.
pub fn substituteHType(arena: Allocator, t: *const HType, context: anytype) Allocator.Error!*const HType {
    switch (t.*) {
        .type_param => |x| return context.lookup(x.name) orelse t,
        .array => |x| return hArray(arena, try substituteHType(arena, x.element, context)),
        .set => |x| return hSet(arena, try substituteHType(arena, x.element, context)),
        .iterator => |x| return hIterator(arena, try substituteHType(arena, x.element, context)),
        .map => |x| return hMap(
            arena,
            try substituteHType(arena, x.key, context),
            try substituteHType(arena, x.value, context),
        ),
        .@"fn" => |x| {
            const params = try arena.alloc(*const HType, x.params.len);
            for (x.params, params) |param, *out| out.* = try substituteHType(arena, param, context);
            return hFunction(arena, params, try substituteHType(arena, x.ret, context));
        },
        // The layout (name, bases, slot order) is what every lookup already resolved against, so
        // only member types change. Terminates because the mapper cuts cyclic layouts at its depth
        // cap rather than building an infinite tree.
        .object => |x| {
            var object = x;
            object.fields = try substituteFields(arena, x.fields, context);
            object.methods = try substituteFields(arena, x.methods, context);
            return make(arena, .{ .object = object });
        },
        else => return t,
    }
}

fn substituteFields(arena: Allocator, fields: []const HField, context: anytype) Allocator.Error![]const HField {
    const out = try arena.alloc(HField, fields.len);
    for (fields, out) |field, *slot| {
        slot.* = .{ .name = field.name, .type = try substituteHType(arena, field.type, context) };
    }
    return out;
}

/// Unspellable, like the receiver's leading space and a static's dot: no identifier holds an angle
/// bracket, so a specialization can never collide with a user binding.
pub fn specializationName(arena: Allocator, name: []const u8, type_arguments: []const *const HType) Allocator.Error![]const u8 {
    var text: std.ArrayList(u8) = .empty;
    try text.print(arena, "{s}<", .{name});
    for (type_arguments, 0..) |argument, index| {
        if (index != 0) try text.appendSlice(arena, ", ");
        try text.appendSlice(arena, try hTypeName(arena, argument));
    }
    try text.append(arena, '>');
    return text.items;
}

test "equality is nominal for classes and structural for functions" {
    var state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer state.deinit();
    const arena = state.allocator();

    const a = try hObject(arena, "C", &.{}, &.{}, &.{}, null);
    const b = try hObject(arena, "C", &.{.{ .name = "x", .type = H_NUMBER }}, &.{}, &.{}, null);
    try std.testing.expect(hTypeEquals(a, b));

    const f = try hFunction(arena, &.{H_NUMBER}, H_STRING);
    const g = try hFunction(arena, &.{H_STRING}, H_STRING);
    try std.testing.expect(!hTypeEquals(f, g));
    try std.testing.expect(hTypeEquals(hUnknown(true), hUnknown(true)));
    try std.testing.expect(!hTypeEquals(hUnknown(true), hUnknown(false)));
}

test "assignability follows the base chain and unknown either way" {
    var state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer state.deinit();
    const arena = state.allocator();

    const animal = try hObject(arena, "Animal", &.{}, &.{}, &.{}, null);
    const dog = try hObject(arena, "Dog", &.{}, &.{}, &.{"Animal"}, null);
    try std.testing.expect(hTypeAssignable(dog, animal));
    try std.testing.expect(!hTypeAssignable(animal, dog));
    try std.testing.expect(hTypeAssignable(hUnknown(false), H_NUMBER));
    try std.testing.expect(hTypeAssignable(
        try hArray(arena, hUnknown(true)),
        try hArray(arena, hUnknown(false)),
    ));
}

test "a subclass view goes where its ancestors and Uint8Array do, never back" {
    var state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer state.deinit();
    const arena = state.allocator();

    const bytes = try hViewClass(arena, .{ .name = "Bytes", .fields = &.{}, .methods = &.{}, .bases = &.{} });
    const tagged = try hViewClass(arena, .{ .name = "Tagged", .fields = &.{}, .methods = &.{}, .bases = &.{"Bytes"} });
    try std.testing.expect(hTypeAssignable(tagged, bytes));
    try std.testing.expect(hTypeAssignable(bytes, H_UINT8ARRAY));
    try std.testing.expect(!hTypeAssignable(bytes, tagged));
    try std.testing.expect(!hTypeAssignable(H_UINT8ARRAY, bytes));
    try std.testing.expect(!hTypeEquals(bytes, H_UINT8ARRAY));
    try std.testing.expectEqualStrings("Tagged", try hTypeName(arena, tagged));
    try std.testing.expectEqualStrings("Tagged", classLayoutOf(tagged).?.name);
    try std.testing.expect(classLayoutOf(H_UINT8ARRAY) == null);
}

test "names match the TypeScript spelling" {
    var state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer state.deinit();
    const arena = state.allocator();

    const f = try hFunction(arena, &.{ H_NUMBER, H_STRING }, H_BOOLEAN);
    try std.testing.expectEqualStrings("(a0: number, a1: string) => boolean", try hTypeName(arena, f));
    try std.testing.expectEqualStrings("((a0: number, a1: string) => boolean)[]", try hTypeName(arena, try hArray(arena, f)));
    try std.testing.expectEqualStrings("number[]", try hTypeName(arena, try hArray(arena, H_NUMBER)));
    try std.testing.expectEqualStrings("box<number>", try specializationName(arena, "box", &.{H_NUMBER}));
    try std.testing.expectEqualStrings("Uint8Array", try hTypeName(arena, H_UINT8ARRAY));
}

test "substitution replaces bound names and leaves the rest" {
    var state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer state.deinit();
    const arena = state.allocator();

    const Bind = struct {
        fn lookup(_: @This(), name: []const u8) ?*const HType {
            return if (std.mem.eql(u8, name, "T")) H_NUMBER else null;
        }
    };
    const t = try hTypeParam(arena, "T");
    const u = try hTypeParam(arena, "U");
    const substituted = try substituteHType(arena, try hMap(arena, t, u), Bind{});
    try std.testing.expect(substituted.map.key.* == .number);
    try std.testing.expect(substituted.map.value.* == .type_param);
    try std.testing.expect(hasTypeParam(substituted));
}

test "accessor names round trip" {
    var state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer state.deinit();
    const name = try accessorName(state.allocator(), .get, "x");
    try std.testing.expectEqualStrings("get x", name);
    try std.testing.expectEqualStrings("x", accessorProperty(name).?);
    try std.testing.expect(accessorProperty("plain") == null);
}
