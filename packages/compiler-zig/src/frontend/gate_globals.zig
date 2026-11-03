//! The ambient globals: which `Math`, `Object`, `Promise`, conversion and builtin-value spellings
//! have a lowering, and what `console.log` formatting can reach.

const std = @import("std");
const api = @import("gate_api.zig");
const types = @import("gate_types.zig");
const N = @import("../hir/nodes.zig");
const keyof = @import("../hir/keyof.zig");

const Gate = api.Gate;
const Node = api.Node;
const Result = api.Result;
const Type = api.Type;
const accept = api.accept;
const eql = api.eql;

fn has(set: []const []const u8, name: []const u8) bool {
    for (set) |item| if (eql(item, name)) return true;
    return false;
}

// The values sit with the names so the gate's verdict and the lowering's fold read one table.
const math_constants = keyof.table(f64, .{
    .E = 2.718281828459045,
    .LN10 = 2.302585092994046,
    .LN2 = 0.6931471805599453,
    .LOG10E = 0.4342944819032518,
    .LOG2E = 1.4426950408889634,
    .PI = 3.141592653589793,
    .SQRT1_2 = 0.7071067811865476,
    .SQRT2 = 1.4142135623730951,
});
const number_constants = keyof.table(f64, .{
    .EPSILON = 2.220446049250313e-16,
    .MAX_SAFE_INTEGER = 9007199254740991,
    .MAX_VALUE = 1.7976931348623157e308,
    .MIN_SAFE_INTEGER = -9007199254740991,
    .MIN_VALUE = 5e-324,
    .NaN = std.math.nan(f64),
    .NEGATIVE_INFINITY = -std.math.inf(f64),
    .POSITIVE_INFINITY = std.math.inf(f64),
});

fn constantIn(comptime rows: anytype, name: []const u8) ?f64 {
    const key = std.meta.stringToEnum(@TypeOf(rows).Key, name) orelse return null;
    return rows.get(key);
}

pub fn isMathMethod(name: []const u8) bool {
    return std.meta.stringToEnum(N.MathMethod, name) != null;
}

pub fn mathConstant(name: []const u8) ?f64 {
    return constantIn(math_constants, name);
}

pub fn isMathConstant(name: []const u8) bool {
    return mathConstant(name) != null;
}

pub fn numberConstant(g: *Gate, node: *Node) ?f64 {
    const x = node.data.prop_access;
    const value = constantIn(number_constants, api.text(x.name) orelse return null) orelse return null;
    return if (isGlobalNamed(g, x.expr, "Number")) value else null;
}

pub fn isGlobalNamed(g: *Gate, node: *Node, name: []const u8) bool {
    if (!api.identifierIs(node, name)) return false;
    return g.declaredOnlyInDeclarationFiles(g.symbolAt(node));
}

pub fn isGlobalMath(g: *Gate, node: *Node) bool {
    return isGlobalNamed(g, node, "Math");
}

pub fn isGlobalString(g: *Gate, node: *Node) bool {
    return isGlobalNamed(g, node, "String");
}

pub fn isGlobalObject(g: *Gate, node: *Node) bool {
    return isGlobalNamed(g, node, "Object");
}

pub fn isGlobalDate(g: *Gate, node: *Node) bool {
    return isGlobalNamed(g, node, "Date");
}

pub fn isGlobalPromise(g: *Gate, node: *Node) bool {
    return isGlobalNamed(g, node, "Promise");
}

pub fn isGlobalJson(g: *Gate, node: *Node) bool {
    return isGlobalNamed(g, node, "JSON");
}

pub fn isGlobalArray(g: *Gate, node: *Node) bool {
    return isGlobalNamed(g, node, "Array");
}

pub fn isDateReceiver(g: *Gate, expression: *Node) bool {
    return types.tsTypeToHType(g, g.typeAt(expression)).* == .date;
}

pub fn typedConstructorOf(g: *Gate, node: *Node) ?N.TypedReceiver {
    if (isGlobalNamed(g, node, "Uint8Array")) return .uint8array;
    return if (isGlobalNamed(g, node, "ArrayBuffer")) .arraybuffer else null;
}

pub fn typedReceiverKind(g: *Gate, expression: *Node) ?N.TypedReceiver {
    return switch (types.tsTypeToHType(g, g.typeAt(expression)).*) {
        .uint8array => .uint8array,
        .arraybuffer => .arraybuffer,
        else => null,
    };
}

pub fn errorCtorName(g: *Gate, node: *Node) ?N.ErrorClass {
    for (N.ERROR_CLASSES) |name| {
        if (isGlobalNamed(g, node, @tagName(name))) return name;
    }
    return null;
}

pub const ObjectWant = enum { dynamic, pairs, shaped };
pub const ObjectSecond = enum { key, none, shaped };
pub const ObjectStatic = struct { name: []const u8, arity: u8, receiver: ObjectWant, second: ObjectSecond };

const object_statics = [_]ObjectStatic{
    .{ .name = "assign", .arity = 2, .receiver = .dynamic, .second = .shaped },
    .{ .name = "entries", .arity = 1, .receiver = .shaped, .second = .none },
    .{ .name = "freeze", .arity = 1, .receiver = .shaped, .second = .none },
    .{ .name = "fromEntries", .arity = 1, .receiver = .pairs, .second = .none },
    .{ .name = "getOwnPropertyNames", .arity = 1, .receiver = .shaped, .second = .none },
    .{ .name = "hasOwn", .arity = 2, .receiver = .shaped, .second = .key },
    .{ .name = "isFrozen", .arity = 1, .receiver = .shaped, .second = .none },
    .{ .name = "keys", .arity = 1, .receiver = .shaped, .second = .none },
    .{ .name = "values", .arity = 1, .receiver = .shaped, .second = .none },
};

pub fn objectStatic(name: []const u8) ?ObjectStatic {
    for (object_statics) |s| if (eql(s.name, name)) return s;
    return null;
}

pub fn objectStaticOwner(name: []const u8) ?u32 {
    const phase_5 = [_][]const u8{ "seal", "isSealed" };
    const phase_8 = [_][]const u8{ "create", "defineProperties", "defineProperty", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getPrototypeOf", "setPrototypeOf" };
    if (has(&phase_5, name)) return 5;
    return if (has(&phase_8, name)) 8 else null;
}

pub fn acceptsObjectArgument(g: *Gate, want: ObjectWant, argument: *Node) bool {
    const t = g.typeAt(argument);
    return switch (want) {
        .pairs => types.tsTypeToHType(g, t).* == .array,
        .dynamic => types.isDynamicShape(g, t),
        .shaped => types.tsTypeToHType(g, t).* == .object or types.isDynamicShape(g, t),
    };
}

pub const PromiseStatic = struct { array: bool };

pub fn promiseStatic(name: []const u8) ?PromiseStatic {
    if (eql(name, "all")) return .{ .array = true };
    if (eql(name, "reject") or eql(name, "resolve")) return .{ .array = false };
    return null;
}

pub fn isArrayOrTuple(g: *Gate, t: *Type) bool {
    return g.isArrayType(t) or api.T.isTupleType(t);
}

const callback_array_ops = [_][]const u8{
    "every",     "sort",     "reduce",        "reduceRight", "filter",  "flatMap", "find",
    "findIndex", "findLast", "findLastIndex", "toSorted",    "forEach", "map",     "some",
};

pub fn isCallbackArrayOp(name: []const u8) bool {
    return has(&callback_array_ops, name);
}

pub fn calleeOnlyMember(g: *Gate, access: *Node, what: []const u8) Result {
    return if (api.isCallee(access)) accept else g.notYet(g.fmt("using {s} as a value is not yet supported", .{what}), 5);
}

pub const CalleeOnly = struct { base: []const u8, members: []const []const u8 };

pub const callee_only_statics = [_]CalleeOnly{
    .{ .base = "Array", .members = &.{ "isArray", "from" } },
    .{ .base = "Number", .members = &.{ "parseInt", "parseFloat", "isFinite", "isNaN" } },
};

const global_conversions = [_][]const u8{ "String", "Number", "Boolean" };

pub const GlobalFunction = []const u8;

fn isPureChain(node: *const Node) bool {
    if (api.isIdentifier(node) or node.data == .this_expr) return true;
    return node.data == .prop_access and !node.data.prop_access.optional and isPureChain(node.data.prop_access.expr);
}

pub fn isSelfBoundCallApply(g: *const Gate, access: *Node) bool {
    const outer = access.parent orelse return false;
    if (outer.data != .prop_access or outer.data.prop_access.expr != access) return false;
    const name = outer.data.prop_access.name;
    if (!api.identifierIs(name, "call") and !api.identifierIs(name, "apply")) return false;
    const call = outer.parent orelse return false;
    if (call.data != .call or call.data.call.callee != outer) return false;
    const args = api.nodes(call.data.call.args);
    if (args.len == 0) return false;
    const this_arg = args[0];
    const base = access.data.prop_access.expr;
    return isPureChain(base) and isPureChain(this_arg) and eql(api.sourceText(g, this_arg), api.sourceText(g, base));
}

pub fn isPlainFunctionValue(g: *Gate, expression: *Node) bool {
    if (builtinValueOf(g, expression)) |value| {
        if (value.row == .object_proto) return true;
    }
    const t = g.typeAt(expression);
    return g.callSignatures(t).len > 0 and g.constructSignatures(t).len == 0;
}

const builtin_value_names = [_][]const u8{ "Object", "Array", "Boolean", "Number", "String", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "ArrayBuffer", "DataView", "Uint8Array", "Promise", "Function", "Error" };
const builtin_proto_names = [_][]const u8{ "Object", "Array", "Number", "String", "Boolean", "Function" };
const object_proto_value_methods = [_][]const u8{ "hasOwnProperty", "toString" };

pub const BuiltinValue = struct { row: enum { ctor, proto, object_proto }, name: []const u8 };

fn isPlainValuePosition(node: *Node) bool {
    var child = node;
    var parent = node.parent orelse return false;
    while (parent.data == .paren) {
        child = parent;
        parent = parent.parent orelse return false;
    }
    switch (parent.data) {
        .call => |x| if (x.callee == child) return false,
        .new_expr => |x| if (x.callee == child) return false,
        .prop_access => |x| if (x.expr == child) return false,
        .elem_access => |x| if (x.expr == child) return false,
        .binary => |x| if (x.op == .kw_instanceof and x.right == child) return false,
        .typeof_expr, .expr_with_type_args, .shorthand_assign => return false,
        else => {},
    }
    return true;
}

fn plainBuiltin(g: *Gate, names: []const []const u8, name_node: *Node, position: *Node) ?[]const u8 {
    const name = api.text(name_node) orelse return null;
    return if (has(names, name) and isGlobalNamed(g, name_node, name) and isPlainValuePosition(position)) name else null;
}

pub fn builtinValueOf(g: *Gate, node: *Node) ?BuiltinValue {
    if (api.isIdentifier(node)) {
        const name = plainBuiltin(g, &builtin_value_names, node, node) orelse return null;
        return .{ .row = .ctor, .name = name };
    }
    if (node.data != .prop_access) return null;
    const x = node.data.prop_access;
    const name = api.text(x.name) orelse return null;
    const base = x.expr;
    if (has(&object_proto_value_methods, name) and base.data == .prop_access and api.identifierIs(base.data.prop_access.name, "prototype") and
        isGlobalNamed(g, base.data.prop_access.expr, "Object") and !api.isCallee(node))
    {
        return .{ .row = .object_proto, .name = name };
    }
    if (eql(name, "prototype") and api.isIdentifier(base)) {
        if (plainBuiltin(g, &builtin_proto_names, base, node)) |base_name| return .{ .row = .proto, .name = base_name };
    }
    return null;
}

pub fn isBuiltinValueOrPart(g: *Gate, node: *Node) bool {
    if (!api.isIdentifier(node) and node.data != .prop_access) return false;
    var current = node;
    for (0..3) |_| {
        if (api.isExpression(current) and builtinValueOf(g, current) != null) return true;
        const parent = current.parent orelse return false;
        if (parent.data != .prop_access or parent.data.prop_access.expr != current) return false;
        current = parent;
    }
    return false;
}

pub fn globalFunctionOf(g: *Gate, node: *Node) ?GlobalFunction {
    if (node.data == .prop_access) {
        const x = node.data.prop_access;
        const name = api.text(x.name) orelse return null;
        if (eql(name, "parseInt") or eql(name, "parseFloat")) return if (isGlobalNamed(g, x.expr, "Number")) name else null;
        if (eql(name, "isFinite") or eql(name, "isNaN")) return if (isGlobalNamed(g, x.expr, "Number")) g.fmt("Number.{s}", .{name}) else null;
        if (eql(name, "from")) return if (isGlobalArray(g, x.expr)) "Array.from" else null;
        if (eql(name, "isView")) return if (isGlobalNamed(g, x.expr, "ArrayBuffer")) "ArrayBuffer.isView" else null;
        return null;
    }
    if (!api.isIdentifier(node)) return null;
    const name = api.text(node) orelse return null;
    if (std.meta.stringToEnum(N.GlobalCallName, name) == null and !has(&global_conversions, name)) return null;
    return if (isGlobalNamed(g, node, name)) name else null;
}

fn mayBeArrayLength(g: *Gate, t: *Type) bool {
    if (api.isUnionType(t)) {
        for (api.parts(g, t)) |part| if (mayBeArrayLength(g, part)) return true;
        return false;
    }
    return api.isNumberLike(t) or api.isAnyFlag(t) or t.data == .unknown or t.data == .param;
}

pub fn globalFunctionArity(name: GlobalFunction) u32 {
    if (has(&global_conversions, name)) return 1;
    const call = std.meta.stringToEnum(N.GlobalCallName, name) orelse return 0;
    return N.GLOBAL_CALLS.get(call).arity;
}

pub fn gateGlobalArguments(g: *Gate, name: GlobalFunction, node: *Node) Result {
    const args = api.nodes(if (node.data == .call) node.data.call.args else node.data.new_expr.args);
    for (args) |a| {
        if (a.data == .spread_elem) return g.notYet(g.fmt("a spread argument to {s} is not yet supported", .{name}), 5);
    }
    if (eql(name, "Array")) {
        if (args.len != 1 or !mayBeArrayLength(g, g.typeAt(args[0]))) return accept;
        const created = types.tsTypeToHType(g, g.typeAt(node));
        return if (created.* == .array and created.array.element.* == .unknown)
            accept
        else
            g.notYet("Array(n) with a typed element is not yet supported: its holes read as undefined", 5);
    }
    return if (args.len > globalFunctionArity(name))
        g.notYet(g.fmt("{s} with {d} arguments is not yet supported", .{ name, args.len }), 5)
    else
        accept;
}

const global_objects = [_][]const u8{ "globalThis", "JSON", "Math", "Reflect", "Atomics", "Intl" };
const global_callables = [_][]const u8{
    "Object",      "Function",    "Array",             "String",       "Number",             "Boolean",       "BigInt",               "Date",
    "RegExp",      "Map",         "Set",               "WeakMap",      "WeakSet",            "WeakRef",       "FinalizationRegistry", "Promise",
    "Proxy",       "ArrayBuffer", "SharedArrayBuffer", "DataView",     "Int8Array",          "Uint8Array",    "Uint8ClampedArray",    "Int16Array",
    "Uint16Array", "Int32Array",  "Uint32Array",       "Float32Array", "Float64Array",       "BigInt64Array", "BigUint64Array",       "Error",
    "EvalError",   "RangeError",  "ReferenceError",    "SyntaxError",  "TypeError",          "URIError",      "AggregateError",       "parseInt",
    "parseFloat",  "isNaN",       "isFinite",          "encodeURI",    "encodeURIComponent", "decodeURI",     "decodeURIComponent",
};

pub fn globalTypeofOf(g: *Gate, node: *Node) bool {
    const name = api.text(node) orelse return false;
    if (!has(&global_objects, name) and !has(&global_callables, name)) return false;
    const symbol = g.symbolAt(node);
    if (symbol == null) return eql(name, "globalThis");
    return g.declaredOnlyInDeclarationFiles(symbol) or (symbol.?.decls.len == 0 and eql(name, "globalThis"));
}

/// What `typeof` of an undeclared global answers, for the lowering to fold.
pub fn globalTypeofAnswer(g: *Gate, node: *Node) ?[]const u8 {
    if (!globalTypeofOf(g, node)) return null;
    return if (has(&global_objects, api.text(node) orelse "")) "object" else "function";
}

pub fn admitsUnserializable(g: *Gate, t: *Type) bool {
    for (api.parts(g, t)) |arm| {
        if (arm.data == .undefined or arm.data == .void or g.callSignatures(arm).len > 0) return true;
    }
    return false;
}

pub const FormatRefusal = struct { what: []const u8, phase: u32 };

fn checkPlaceholder(g: *Gate, spec: u8, argument: *Node) ?FormatRefusal {
    for (api.parts(g, g.typeAt(argument))) |arm| {
        const primitive = api.isStringLike(arm) or api.isNumberLike(arm) or api.isBooleanLike(arm) or arm.data == .undefined or
            arm.data == .void or arm.data == .null or api.isAnyFlag(arm) or arm.data == .unknown;
        if (spec == 'o' and !primitive) return .{ .what = "%o of an object", .phase = 5 };
        if (spec == 's' and (g.callSignatures(arm).len > 0 or g.constructSignatures(arm).len > 0)) {
            return .{ .what = "%s of a function", .phase = 5 };
        }
    }
    return null;
}

pub fn formatRefusal(g: *Gate, call: *Node) ?FormatRefusal {
    const args = api.nodes(call.data.call.args);
    if (args.len < 2) return null;
    const format_type = g.typeAt(args[0]);
    if (format_type.data != .str_lit) return null;
    const format = format_type.data.str_lit;
    var consumed: usize = 0;
    var i: usize = 0;
    while (i + 1 < format.len) : (i += 1) {
        if (format[i] != '%') continue;
        i += 1;
        const spec = format[i];
        if (consumed + 1 != args.len and std.mem.indexOfScalar(u8, "sjdOoifc", spec) != null) {
            consumed += 1;
            if (consumed < args.len) {
                if (checkPlaceholder(g, spec, args[consumed])) |refusal| return refusal;
            }
        }
    }
    return null;
}

pub fn isConsoleLog(access: *const Node) bool {
    const x = access.data.prop_access;
    if (!api.identifierIs(x.expr, "console")) return false;
    const name = api.text(x.name) orelse return false;
    return std.meta.stringToEnum(N.ConsoleMethod, name) != null;
}
