//! Calls: which callee, receiver and argument shapes lowering has a form for.

const std = @import("std");
const api = @import("gate_api.zig");
const types = @import("gate_types.zig");
const core = @import("gate.zig");
const extern_ = @import("gate_extern.zig");
const generics = @import("gate_generics.zig");
const globals = @import("gate_globals.zig");
const member = @import("gate_member.zig");
const ops = @import("gate_ops.zig");
const N = @import("../hir/nodes.zig");
const H = @import("../hir/types.zig");
const support = @import("../support/root.zig");

const Gate = api.Gate;
const Node = api.Node;
const Result = api.Result;
const Type = api.Type;
const accept = api.accept;
const eql = api.eql;

fn enumHas(comptime E: type, name: []const u8) ?E {
    return std.meta.stringToEnum(E, name);
}

pub fn hasSpread(args: []const *Node) bool {
    for (args) |a| if (a.data == .spread_elem) return true;
    return false;
}

fn hirKind(g: *Gate, n: *Node) std.meta.Tag(H.HType) {
    return types.tsTypeToHType(g, g.typeAt(n)).*;
}

fn untyped(t: *const Type) bool {
    return api.isAnyFlag(t) or t.data == .unknown;
}

pub fn acceptsSymbolKeyBase(g: *Gate, base: *Node) bool {
    const hir = types.tsTypeToHType(g, g.typeAt(base));
    return types.userIteratorMethod(hir) != null or hir.* == .unknown;
}

fn optionalChainMethodReceiver(g: *Gate, receiver: *Node, name: []const u8) ?Result {
    const live = extern_.nonNullishConstituents(g, g.typeAt(receiver));
    var all_untyped = true;
    for (live) |t| {
        if (!untyped(t)) all_untyped = false;
    }
    if (all_untyped) return null;
    if (extern_.singleClassMethod(g, live, name) != null) return null;
    for (live) |constituent| {
        const mapped = types.tsTypeToHType(g, constituent);
        if (mapped.* == .unknown) continue;
        if (mapped.* == .object) {
            const declaration = api.valueDeclaration(api.typeSymbol(constituent)) orelse continue;
            if (!api.isClassDeclaration(declaration)) continue;
        }
        return g.notYet(g.fmt("calling '{s}' through an optional chain on this receiver is not yet supported", .{name}), 5);
    }
    return null;
}

pub fn optionalChainElementReceiver(g: *Gate, access: *Node) ?Result {
    if (!access.data.elem_access.optional) return null;
    const live = extern_.nonNullishConstituents(g, g.typeAt(access.data.elem_access.expr));
    for (live) |t| {
        const mapped = types.tsTypeToHType(g, t);
        if (mapped.* == .string or mapped.* == .number or mapped.* == .boolean) {
            return g.notYet(g.fmt("indexing a {s} through an optional chain is not yet supported", .{H.hTypeName(g.a, mapped) catch api.oom()}), 5);
        }
    }
    return null;
}

pub fn gateCall(g: *Gate, call: *Node) Result {
    const x = call.data.call;
    const args = api.nodes(x.args);
    if (core.dynamicCodeGeneration(g, x.callee)) |kind| {
        return if (kind == .eval) core.evalResult(g) else core.functionCtorResult(g);
    }
    const callee = api.skipParens(x.callee);
    if (callee.data == .import_kw) return core.gateImportCall(g, call);
    const generic = generics.genericCallInstantiation(g, call);
    if (generic == .not_generic and api.typeArgsPresent(x.type_args)) {
        return g.notYet("explicit type arguments on a call are not yet supported", 5);
    }
    if (generic == .generic) {
        const bound = member.enclosingTypeParameterNames(g, call);
        for (generic.generic) |t| {
            if (member.mentionsUnboundParameter(g, t, bound)) {
                return g.notYet("a generic call at a generic type is not yet supported: self-application infers a generic tuple that no monomorphic copy can spell", 5);
            }
        }
    }
    if (extern_.externDeclarationOfCall(g, call)) |declaration| return extern_.gateExternCall(g, call, declaration);
    if (extern_.outSlotDeclarationOf(g, call) != null) return extern_.gateOutSlotCall(g, call);
    if (globals.globalFunctionOf(g, callee)) |name| return globals.gateGlobalArguments(g, name, call);

    if (callee.data == .prop_access and !core.isNamespaceMember(g, callee)) return gateMethodCall(g, call, callee, args);

    if (callee.data == .elem_access and callee.data.elem_access.optional) {
        if (types.elementStaticKey(g, callee.data.elem_access.index)) |key| {
            const receiver = callee.data.elem_access.expr;
            if (classOrConstraint(g, receiver) == null) {
                if (optionalChainMethodReceiver(g, receiver, key)) |refused| return refused;
            }
        }
    }
    if (callee.data == .super_expr) {
        return if (hasSpread(args)) g.notYet("a spread argument to a super call is not yet supported", 5) else accept;
    }
    if (hasSpread(args)) return spreadCallRefusal(g, call) orelse accept;
    return accept;
}

fn classOrConstraint(g: *Gate, receiver: *Node) ?*Node {
    const t = g.typeAt(receiver);
    return types.classDeclarationOf(t) orelse member.constraintDeclaration(g, t);
}

fn gateConsole(g: *Gate, call: *Node, name: []const u8, args: []const *Node) Result {
    const method = enumHas(N.ConsoleMethod, name) orelse return accept;
    const shape = N.CONSOLE_METHODS.get(method);
    const given = args.len;
    if (hasSpread(args)) return g.notYet(g.fmt("a spread argument to console.{s} is not yet supported", .{name}), 5);
    if (shape.variadic != null) {
        if (globals.formatRefusal(g, call)) |placeholder| {
            return g.notYet(g.fmt("console.{s} {s} is not yet supported", .{ name, placeholder.what }), placeholder.phase);
        }
    } else if (given > shape.arity or given + shape.optional < shape.arity) {
        return g.notYet(g.fmt("console.{s} with {d} arguments is not yet supported", .{ name, given }), 5);
    }
    if (method != .table or args.len == 0 or collectionOf(g, args[0]) == null) return accept;
    return g.notYet("console.table on a Map or a Set is not yet supported", 5);
}

fn gateJson(g: *Gate, method: []const u8, args: []const *Node) Result {
    const is_parse = eql(method, "parse");
    if (!is_parse and !eql(method, "stringify")) return g.notYet(g.fmt("JSON.{s} is not yet supported", .{method}), 5);
    if (args.len != 1) return g.notYet(g.fmt("JSON.{s} with other than one argument is not yet supported", .{method}), 5);
    const argument = args[0];
    if (argument.data == .spread_elem) return g.notYet(g.fmt("a spread argument to JSON.{s} is not yet supported", .{method}), 5);
    if (is_parse) {
        if (untyped(g.typeAt(argument)) or member.isStringReceiver(g, argument)) return accept;
        return g.notYet("JSON.parse of a value that is not a string is not yet supported", 5);
    }
    return if (globals.admitsUnserializable(g, g.typeAt(argument)))
        g.notYet("JSON.stringify of a value that may be undefined or a function is not yet supported", 5)
    else
        accept;
}

fn gateObjectStatic(g: *Gate, method: []const u8, args: []const *Node) Result {
    const shape = globals.objectStatic(method) orelse {
        return g.notYet(g.fmt("Object.{s} is not yet supported", .{method}), globals.objectStaticOwner(method) orelse 5);
    };
    if (args.len != shape.arity) return g.notYet(g.fmt("Object.{s} with other than {d} arguments is not yet supported", .{ method, shape.arity }), 5);
    if (hasSpread(args)) return g.notYet("a spread argument to an Object method is not yet supported", 5);
    const argument = args[0];
    const unknown_keys = eql(method, "keys") and hirKind(g, argument) == .unknown;
    if (!unknown_keys and !globals.acceptsObjectArgument(g, shape.receiver, argument)) {
        return g.notYet(g.fmt("Object.{s} on this argument type is not yet supported", .{method}), 5);
    }
    if (shape.second == .none) return accept;
    if (args.len < 2) return g.notYet(g.fmt("Object.{s} without a second argument is not yet supported", .{method}), 5);
    const second = args[1];
    if (shape.second == .key) {
        return if (member.isStringReceiver(g, second))
            accept
        else
            g.notYet(g.fmt("Object.{s} with a key that is not a string is not yet supported", .{method}), 5);
    }
    return if (globals.acceptsObjectArgument(g, .shaped, second))
        accept
    else
        g.notYet(g.fmt("Object.{s} from this source type is not yet supported", .{method}), 5);
}

fn gateDateStatic(g: *Gate, method: []const u8, args: []const *Node) Result {
    const static = enumHas(N.DateStatic, method) orelse return core.dateNotYet(g, g.fmt("Date.{s}", .{method}), 5);
    const shape = N.DATE_STATICS.get(static);
    if (hasSpread(args)) return core.dateNotYet(g, "a spread argument to a Date method", 5);
    return if (args.len > shape.arity or args.len + shape.optional < shape.arity)
        core.dateNotYet(g, g.fmt("Date.{s} with {d} arguments", .{ method, args.len }), 5)
    else
        accept;
}

fn gatePromiseStatic(g: *Gate, method: []const u8, args: []const *Node) Result {
    const static = globals.promiseStatic(method) orelse return g.notYet(g.fmt("Promise.{s} is not yet supported", .{method}), 5);
    if (args.len != 1) return g.notYet(g.fmt("Promise.{s} with other than one argument is not yet supported", .{method}), 5);
    const argument = args[0];
    if (argument.data == .spread_elem) return g.notYet("a spread argument to a Promise method is not yet supported", 5);
    if (static.array and !globals.isArrayOrTuple(g, g.typeAt(argument))) {
        return g.notYet("Promise.all over a non-array is not yet supported", 5);
    }
    return accept;
}

fn gateStringMethod(g: *Gate, op: []const u8, args: []const *Node) Result {
    const known = enumHas(N.StringOpName, op) orelse return g.notYet(g.fmt("String.prototype.{s} is not yet supported", .{op}), 5);
    if (hasSpread(args)) return g.notYet("a spread argument to a string method is not yet supported", 5);
    if (known == .split and args.len > 1) return g.notYet("split with a limit is not yet supported", 5);
    if (known == .split or known == .replace or known == .replaceAll or known == .search) {
        for (args, 0..) |argument, index| {
            const kind = hirKind(g, argument);
            const refused = if (kind == .regexp) index != 0 else kind != .string;
            if (refused) return g.notYet(g.fmt("{s} with this argument type is not yet supported", .{op}), 5);
        }
        if (known == .search and (args.len == 0 or !member.isRegExpReceiver(g, args[0]))) {
            return g.notYet("search with anything but a regular expression is not yet supported", 5);
        }
    }
    if (known == .matchAll and (args.len == 0 or !member.isRegExpReceiver(g, args[0]))) {
        return g.notYet("matchAll with anything but a regular expression is not yet supported", 5);
    }
    if (known == .localeCompare or known == .toLocaleLowerCase or known == .toLocaleUpperCase) {
        if (!support.features.intlEnabled(support.features.runtimeFlavor(g.runtime))) {
            return api.notYetCode("STA1215", g.fmt("String.prototype.{s} needs the ICU feature build: rebuild with `just runtime-intl` and compile with STATOR_RUNTIME=intl", .{op}), null);
        }
        if (args.len != N.STRING_OPS.get(known).arity) return g.notYet(g.fmt("{s} without an explicit locale is not yet supported", .{op}), 5);
        for (args) |argument| {
            if (hirKind(g, argument) != .string) return g.notYet(g.fmt("{s} with this argument type is not yet supported", .{op}), 5);
        }
    }
    return accept;
}

fn gateArrayMethod(g: *Gate, op: []const u8, args: []const *Node) Result {
    if (enumHas(N.ArrayOpName, op) == null) return g.notYet(g.fmt("Array.prototype.{s} is not yet supported", .{op}), 5);
    const callback = globals.isCallbackArrayOp(op);
    if (hasSpread(args)) {
        return if (callback or eql(op, "toSpliced"))
            g.notYet(g.fmt("a spread argument to Array.prototype.{s} is not yet supported", .{op}), 5)
        else
            accept;
    }
    if (eql(op, "lastIndexOf") and args.len > 2) return g.notYet("lastIndexOf with more than two arguments is not yet supported", 5);
    if (eql(op, "toSpliced") and args.len != 2) return g.notYet(g.fmt("{s} with other than two arguments is not yet supported", .{op}), 5);
    if ((eql(op, "sort") or eql(op, "toSorted")) and args.len == 0) return accept;
    if (eql(op, "reduce") or eql(op, "reduceRight")) {
        if (args.len != 2) return g.notYet(g.fmt("{s} without an initial value is not yet supported", .{op}), 5);
    } else if (callback and args.len != 1) {
        return g.notYet(g.fmt("{s} with a thisArg is not yet supported", .{op}), 5);
    }
    if (callback and (args.len == 0 or g.callSignatures(g.typeAt(args[0])).len == 0)) {
        return g.notYet(g.fmt("{s} with a non-function callback is not yet supported", .{op}), 5);
    }
    return accept;
}

fn gateRegExpMethod(g: *Gate, op: []const u8, args: []const *Node) Result {
    const known = enumHas(N.RegExpOperation, op) orelse {
        return api.notYetCode("STA1211", g.fmt("RegExp.prototype.{s} is not yet supported; planned for Phase 8", .{op}), 8);
    };
    if (hasSpread(args)) return g.notYet("a spread argument to a RegExp method is not yet supported", 5);
    const arity = N.REGEXP_OPS.get(known).arity;
    if (args.len != arity) return g.notYet(g.fmt("{s} with other than {d} arguments is not yet supported", .{ op, arity }), 5);
    if (args.len == 0) return accept;
    const subject = args[0];
    if (untyped(g.typeAt(subject)) or member.isStringReceiver(g, subject)) return accept;
    return g.notYet(g.fmt("{s} of a value that is not a string is not yet supported", .{op}), 5);
}

fn gateDateMethod(g: *Gate, op: []const u8, args: []const *Node) Result {
    const known = enumHas(N.DateOperation, op) orelse return core.dateNotYet(g, g.fmt("Date.prototype.{s}", .{op}), null);
    if (hasSpread(args)) return core.dateNotYet(g, "a spread argument to a Date method", 5);
    const shape = N.DATE_OPS.get(known);
    return if (args.len > shape.arity or args.len + shape.optional < shape.arity)
        core.dateNotYet(g, g.fmt("{s} with {d} arguments", .{ op, args.len }), 5)
    else
        accept;
}

fn gateMethodCall(g: *Gate, call: *Node, callee: *Node, args: []const *Node) Result {
    const access = callee.data.prop_access;
    const receiver = access.expr;
    const name = api.text(access.name) orelse "";
    if (globals.isConsoleLog(callee)) return gateConsole(g, call, name, args);
    if (globals.isGlobalMath(g, receiver)) {
        if (!globals.isMathMethod(name)) return g.notYet(g.fmt("Math.{s} is not yet supported", .{name}), 5);
        if (hasSpread(args)) return g.notYet("a spread argument to a Math method is not yet supported", 5);
        if (eql(name, "hypot") and args.len > 2) return g.notYet("Math.hypot with more than two arguments is not yet supported", 5);
        return accept;
    }
    if (globals.isGlobalJson(g, receiver)) return gateJson(g, name, args);
    if (globals.isGlobalObject(g, receiver)) return gateObjectStatic(g, name, args);
    if (globals.isGlobalDate(g, receiver)) return gateDateStatic(g, name, args);
    if (globals.isGlobalPromise(g, receiver)) return gatePromiseStatic(g, name, args);
    if (globals.isGlobalString(g, receiver)) {
        if (!eql(name, "fromCharCode")) return g.notYet(g.fmt("String.{s} is not yet supported", .{name}), 5);
        if (hasSpread(args)) return g.notYet("a spread argument to String.fromCharCode is not yet supported", 5);
        return accept;
    }
    if (globals.isGlobalNamed(g, receiver, "Number")) return g.notYet(g.fmt("Number.{s} is not yet supported", .{name}), 5);
    if (hirKind(g, receiver) == .number) {
        if (enumHas(N.NumberOperation, name) == null) return g.notYet(g.fmt("Number.prototype.{s} is not yet supported", .{name}), 5);
        if (hasSpread(args)) return g.notYet(g.fmt("a spread argument to Number.prototype.{s} is not yet supported", .{name}), 5);
        return if (args.len > 1) g.notYet(g.fmt("{s} with {d} arguments is not yet supported", .{ name, args.len }), 5) else accept;
    }
    if (globals.isGlobalArray(g, receiver)) {
        if (!eql(name, "isArray")) return g.notYet(g.fmt("Array.{s} is not yet supported", .{name}), 5);
        if (hasSpread(args)) return g.notYet("a spread argument to Array.isArray is not yet supported", 5);
        return if (args.len > 1) g.notYet(g.fmt("Array.isArray with {d} arguments is not yet supported", .{args.len}), 5) else accept;
    }
    if (hirKind(g, receiver) == .promise) {
        if (eql(name, "then") or eql(name, "catch") or eql(name, "finally")) {
            return if (hasSpread(args))
                g.notYet(g.fmt("a spread argument to Promise.prototype.{s} is not yet supported", .{name}), 5)
            else
                accept;
        }
        return api.notYetCode("STA1216", g.fmt("Promise.prototype.{s} is not yet supported: use an async function, whose await and return do the same work", .{name}), 5);
    }
    if (member.isStringReceiver(g, receiver) or member.constraintMatches(g, receiver, .string)) return gateStringMethod(g, name, args);
    if (member.isArrayReceiver(g, receiver) or member.constraintMatches(g, receiver, .array)) return gateArrayMethod(g, name, args);
    if (member.isRegExpReceiver(g, receiver) or member.constraintMatches(g, receiver, .regexp)) return gateRegExpMethod(g, name, args);
    if (globals.typedReceiverKind(g, receiver)) |typed_receiver| {
        const op = N.typedMember(typed_receiver, name) orelse {
            return g.notYet(g.fmt("{s}.prototype.{s} is not yet supported", .{ N.typedClassName(typed_receiver), name }), 11);
        };
        const shape = N.TYPED_OPS.get(op);
        if (hasSpread(args)) return g.notYet(g.fmt("a spread argument to {s} is not yet supported", .{@tagName(op)}), 11);
        return if (args.len > shape.arity or args.len < shape.required)
            g.notYet(g.fmt("{s} with {d} arguments is not yet supported", .{ @tagName(op), args.len }), 11)
        else
            accept;
    }
    if (globals.isDateReceiver(g, receiver) or member.constraintMatches(g, receiver, .date)) return gateDateMethod(g, name, args);
    if (gateCollectionCall(g, call, callee)) |collection| return collection;
    if (hasSpread(args)) return gateSpreadMethodCall(g, call, callee);
    if (types.staticMemberOf(g, callee, true) != null) return accept;
    if (eql(name, "next") or eql(name, "return") or eql(name, "throw")) {
        if (hirKind(g, receiver) == .iterator) {
            if (!eql(name, "next") and !member.isGeneratorReceiver(g, receiver)) {
                return g.notYet(g.fmt("Iterator.{s} on a specialized iterator is not yet supported", .{name}), 5);
            }
            return if (args.len <= 1) accept else g.notYet(g.fmt("Iterator.{s} with more than one argument is not yet supported", .{name}), 5);
        }
    }
    if (classOrConstraint(g, receiver) != null) return accept;
    if (member.isMatchReceiver(g, receiver)) return g.notYet(g.fmt("{s} on a RegExp match is not yet supported", .{name}), 5);
    if (access.optional) {
        if (optionalChainMethodReceiver(g, receiver, name)) |refused| return refused;
    }
    const shape = types.tsTypeToHType(g, g.typeAt(receiver));
    if (readsAsUnknown(g, receiver, shape)) return accept;
    if (shape.* == .object) {
        for (shape.object.methods) |m| if (eql(m.name, name)) return accept;
    }
    if (H.callableFieldSlot(shape, name) != null) return accept;
    if (types.isFunctionValueMember(g, receiver, name)) return functionMemberResult(g);
    if (g.mode == .js and types.isUndeclaredMemberRead(g, callee)) return accept;
    if (g.mode == .js and shape.* == .object and shape.object.namespace != true) {
        for (shape.object.fields) |field| {
            if (eql(field.name, name) and (field.type.* == .null or field.type.* == .undefined or field.type.* == .unknown)) return accept;
        }
    }
    if ((eql(name, "call") or eql(name, "apply")) and globals.isPlainFunctionValue(g, receiver)) {
        return if (hasSpread(args))
            g.notYet(g.fmt("a spread argument to Function.prototype.{s} is not yet supported", .{name}), 5)
        else
            accept;
    }
    return g.notYet("method calls are not yet supported", 5);
}

fn claimsNothing(g: *Gate, parameter: *Node) bool {
    const t = g.typeAt(parameter);
    const is_rest = parameter.data.param.dotdotdot;
    if (is_rest and g.isArrayType(t)) {
        const elements = g.typeArguments(t);
        return elements.len > 0 and elements[0].data == .unknown;
    }
    return t.data == .unknown;
}

fn spreadCallRefusal(g: *Gate, call: *Node) ?Result {
    if (api.isOptionalChain(call)) return g.notYet("a spread argument in an optional chain is not yet supported", 5);
    if (g.mode != .js) return null;
    const signature = g.resolvedSignature(call) orelse return null;
    const declaration = signature.decl orelse return null;
    if (declaration.data != .func) return null;
    for (declaration.data.func.params) |parameter| {
        if (api.ast.writtenType(parameter, parameter.data.param.type) != null and !claimsNothing(g, parameter)) {
            return g.notYet("a spread argument to a function with annotated TypeScript parameters is not yet supported in js mode", 5);
        }
    }
    return null;
}

fn gateSpreadMethodCall(g: *Gate, call: *Node, callee: *Node) Result {
    if (spreadCallRefusal(g, call)) |refused| return refused;
    const access = callee.data.prop_access;
    if (access.expr.data == .super_expr) return g.notYet("a spread argument to a super method call is not yet supported", 5);
    if (types.staticMemberOf(g, callee, true) != null) return accept;
    if (types.isFunctionValueMember(g, access.expr, api.text(access.name) orelse "")) return functionMemberResult(g);
    const receiver = hirKind(g, access.expr);
    return if ((receiver == .unknown or receiver == .object) and !member.isMatchReceiver(g, access.expr))
        accept
    else
        g.notYet("a spread argument to a method call is not yet supported", 5);
}

const Op = struct { name: []const u8, arity: u8 };

const map_ops = [_]Op{
    .{ .name = "get", .arity = 1 },    .{ .name = "set", .arity = 2 },    .{ .name = "has", .arity = 1 },
    .{ .name = "delete", .arity = 1 }, .{ .name = "clear", .arity = 0 },  .{ .name = "forEach", .arity = 1 },
    .{ .name = "keys", .arity = 0 },   .{ .name = "values", .arity = 0 }, .{ .name = "entries", .arity = 0 },
};

const set_ops = [_]Op{
    .{ .name = "add", .arity = 1 },            .{ .name = "has", .arity = 1 },
    .{ .name = "delete", .arity = 1 },         .{ .name = "clear", .arity = 0 },
    .{ .name = "forEach", .arity = 1 },        .{ .name = "keys", .arity = 0 },
    .{ .name = "values", .arity = 0 },         .{ .name = "entries", .arity = 0 },
    .{ .name = "union", .arity = 1 },          .{ .name = "intersection", .arity = 1 },
    .{ .name = "difference", .arity = 1 },     .{ .name = "symmetricDifference", .arity = 1 },
    .{ .name = "isSubsetOf", .arity = 1 },     .{ .name = "isSupersetOf", .arity = 1 },
    .{ .name = "isDisjointFrom", .arity = 1 },
};

pub const Collection = enum { map, set };

pub fn collectionOf(g: *Gate, expression: *Node) ?Collection {
    return switch (hirKind(g, expression)) {
        .map => .map,
        .set => .set,
        else => null,
    };
}

pub fn collectionName(collection: Collection) []const u8 {
    return if (collection == .map) "Map" else "Set";
}

pub fn collectionArity(collection: Collection, name: []const u8) ?u8 {
    const table: []const Op = if (collection == .map) &map_ops else &set_ops;
    for (table) |op| if (eql(op.name, name)) return op.arity;
    return null;
}

fn gateCollectionCall(g: *Gate, call: *Node, callee: *Node) ?Result {
    const access = callee.data.prop_access;
    const collection = collectionOf(g, access.expr) orelse member.constraintCollection(g, access.expr) orelse return null;
    const name = api.text(access.name) orelse "";
    const args = api.nodes(call.data.call.args);
    const label = collectionName(collection);
    const arity = collectionArity(collection, name) orelse return g.notYet(g.fmt("{s} on a {s} is not yet supported", .{ name, label }), 5);
    if (hasSpread(args)) return g.notYet(g.fmt("a spread argument to a {s} method is not yet supported", .{label}), 5);
    if (args.len != arity) return g.notYet(g.fmt("{s}.{s} with {d} arguments is not yet supported", .{ label, name, args.len }), 5);
    if (N.isSetOperation(name)) {
        if (args.len == 0 or collectionOf(g, args[0]) != .set) {
            return g.notYet(g.fmt("Set.{s} with an argument that is not a Set is not yet supported", .{name}), 5);
        }
        return accept;
    }
    if (eql(name, "forEach") and (args.len == 0 or g.callSignatures(g.typeAt(args[0])).len == 0)) {
        return g.notYet(g.fmt("{s}.forEach with a non-function callback is not yet supported", .{label}), 5);
    }
    return accept;
}

pub fn readsAsUnknown(g: *Gate, receiver: *Node, shape: *const H.HType) bool {
    return shape.* == .unknown or (g.mode == .js and types.isFunctionMemberRead(g, receiver));
}

pub fn functionMemberResult(g: *Gate) Result {
    return if (g.mode == .js) accept else g.notYet("a property of a function value is not yet supported in ts mode", 8);
}

pub fn gateNew(g: *Gate, n: *Node) Result {
    const x = n.data.new_expr;
    if (core.dynamicCodeGeneration(g, x.callee) == .function) return core.functionCtorResult(g);
    const args = api.nodes(x.args);
    if (collectionOf(g, n)) |collection| {
        return if (args.len == 0)
            accept
        else
            g.notYet(g.fmt("constructing a {s} from an iterable is not yet supported", .{collectionName(collection)}), 5);
    }
    if (globals.isGlobalPromise(g, x.callee)) {
        if (args.len == 1 and args[0].data != .spread_elem) return accept;
        return api.notYetCode("STA1216", "new Promise(executor) is not yet supported: the executor is a JS callback whose throw must become a rejection, which needs a runtime-level catch", 5);
    }
    if (globals.isGlobalDate(g, x.callee)) {
        if (args.len == 0) return accept;
        if (hasSpread(args)) return core.dateNotYet(g, "a spread argument to new Date", 5);
        if (args.len > 7) return core.dateNotYet(g, g.fmt("new Date with {d} arguments", .{args.len}), 5);
        return accept;
    }
    if (globals.typedConstructorOf(g, x.callee)) |typed| {
        const op: N.TypedOperation = if (typed == .uint8array) .@"new Uint8Array" else .@"new ArrayBuffer";
        if (hasSpread(args)) return g.notYet(g.fmt("a spread argument to {s} is not yet supported", .{@tagName(op)}), 11);
        return if (args.len <= N.TYPED_OPS.get(op).arity)
            accept
        else
            g.notYet(g.fmt("{s} with {d} arguments is not yet supported", .{ @tagName(op), args.len }), 11);
    }
    if (globals.errorCtorName(g, x.callee) != null) {
        if (hasSpread(args)) return g.notYet("a spread argument to an Error constructor is not yet supported", 5);
        return if (args.len <= 1) accept else g.notYet("the Error constructor options argument is not yet supported", 5);
    }
    if (globals.globalFunctionOf(g, x.callee)) |global| {
        if (eql(global, "RegExp") or eql(global, "Array")) return globals.gateGlobalArguments(g, global, n);
    }
    if (g.mode == .js and types.isFunctionValueCallee(g, x.callee)) {
        return if (hasSpread(args)) g.notYet("a spread argument to a constructor is not yet supported", 5) else accept;
    }
    if (api.typeArgsPresent(x.type_args) and !generics.isGenericNew(g, n)) {
        return g.notYet("explicit type arguments on a constructor call are not yet supported", 5);
    }
    if (!api.isIdentifier(x.callee)) return g.notYet("new on anything but a named class is not yet supported", 5);
    const made = g.typeAt(n);
    if (types.classDeclarationOf(made) == null) {
        const like = types.classLikeOf(made);
        if (like == null or types.classDisplayName(like.?) == null) return g.notYet("new on this type is not yet supported", 5);
    }
    return if (hasSpread(args)) g.notYet("a spread argument to a constructor is not yet supported", 5) else accept;
}
