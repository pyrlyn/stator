//! One C rvalue per HIR expression. Mirrors `packages/compiler/src/codegen/expressions.ts`, which
//! keeps the reasoning behind each shape. Text built here is compared byte for byte with that
//! emitter, so anything with a side effect on the emitter (an inline-cache site, a pad, a captured
//! operand) runs in the order the template strings there run it.

const std = @import("std");
const nodes = @import("../hir/nodes.zig");
const types = @import("../hir/types.zig");
const emitter = @import("emitter.zig");
const helpers = @import("helpers.zig");
const literals = @import("literals.zig");
const tables = @import("tables.zig");
const slotOperands = @import("runtime_calls.zig").slotList;

const Emitter = emitter.Emitter;
const Error = emitter.Error;
const Captured = emitter.Captured;
const Parts = emitter.Parts;
const Expression = nodes.Expression;
const Span = nodes.Span;
const HType = types.HType;
const hTypeConversionRunsUserCode = types.hTypeConversionRunsUserCode;

const IndexBase = struct { base: usize, target: []const u8, second: []const u8, parts: Parts };

fn requireIndexBase(e: *Emitter, key: anytype, missing: []const u8) Error!IndexBase {
    const base = try e.slotOf(&e.index_slots, key, missing);
    return .{ .base = base, .target = try e.slotAt(base), .second = try e.slotAt(base + 1), .parts = .empty };
}

fn requireCallBase(e: *Emitter, expr: anytype, kind: []const u8) Error!usize {
    return e.call_slots.get(expr) orelse e.fail("{s} was not registered during counting", .{kind});
}

fn emitBranchArm(e: *Emitter, span: Span, temp: []const u8, open: ?[]const u8, arm: Captured, close_with: []const u8) Error!void {
    if (open) |text| try e.appendLine(text, span);
    e.indent += 1;
    try e.pushLines(arm.lines);
    try e.line(span, "{s} = {s};", .{ temp, arm.value });
    e.indent -= 1;
    try e.appendLine(close_with, span);
}

fn requireTempSlot(e: *Emitter, expr: anytype, what: []const u8) Error![]const u8 {
    const slot = e.temp_slots.get(expr) orelse
        return e.fail("{s} has no frame slot; countExpression missed a node", .{what});
    return e.slotAt(slot);
}

const Sequenced = struct { base: usize, parts: Parts, flushed: bool, operands: []const u8 };

fn sequenceCallOperands(e: *Emitter, expr: anytype, kind: []const u8) Error!Sequenced {
    const base = try requireCallBase(e, expr, kind);
    var parts: Parts = .empty;
    const flushed = try e.sequenceArgs(&parts, expr.args, expr.span, base, 0);
    return .{ .base = base, .parts = parts, .flushed = flushed, .operands = try slotOperands(e, base, expr.args.len) };
}

/// `target` and `value` go through slots, so a write that throws finds both rooted.
fn sequenceTargetAndValue(e: *Emitter, stmt: anytype) Error!IndexBase {
    var indexed = try requireIndexBase(e, stmt, "field assignment was not registered during counting");
    _ = try e.sequenceAssign(&indexed.parts, stmt.target, stmt.span, indexed.base);
    _ = try e.sequenceAssign(&indexed.parts, stmt.value, stmt.span, indexed.base + 1);
    return indexed;
}

/// `stmt` is a `FieldAssignment` (a known slot) or a `DynFieldAssignment` (a named property).
pub fn emitFieldWrite(e: *Emitter, stmt: anytype) Error!void {
    var indexed = try sequenceTargetAndValue(e, stmt);
    const write = switch (@TypeOf(stmt)) {
        *const nodes.FieldAssignment => try e.fmt("jsrt_object_set({s}, {d}, {s})", .{ indexed.target, stmt.slot, indexed.second }),
        *const nodes.DynFieldAssignment => try e.fmt("jsrt_set_prop({s}, {s}, {s}, &{s})", .{
            indexed.target,
            try literals.cNameLiteral(e.arena, stmt.field),
            indexed.second,
            try e.icSite(),
        }),
        else => @compileError("emitFieldWrite takes a field assignment"),
    };
    try indexed.parts.append(e.arena, write);
    try e.flushParts(&indexed.parts, stmt.span);
    try e.emitPendingCheck(stmt.span);
}

/// A call kept for its effect in expression position: checked at once, its value is `undefined`.
fn emitEffectValue(e: *Emitter, span: Span, call: []const u8) Error![]const u8 {
    try e.line(span, "{s};", .{call});
    try e.emitPendingCheck(span);
    return "JSRT_UNDEFINED";
}

/// A call that may throw stores into `result` and is checked before anything reads it.
fn assignChecked(e: *Emitter, span: Span, result: []const u8, call: []const u8) Error![]const u8 {
    try e.line(span, "{s} = {s};", .{ result, call });
    try e.emitPendingCheck(span);
    return result;
}

/// The target is stored in the expression's own slot first, so the read after it finds it rooted.
fn targetInTempSlot(e: *Emitter, expr: anytype, message: []const u8) Error![]const u8 {
    const result = try e.slotAt(try e.slotOf(&e.temp_slots, expr, message));
    try e.line(expr.span, "{s} = {s};", .{ result, try e.emitExpression(expr.target) });
    return result;
}

fn argvAt(e: *Emitter, base: usize, count: usize) Error![]const u8 {
    return if (count == 0) "NULL" else e.fmt("&{s}", .{try e.slotAt(base + 1)});
}

/// `head` (callee, receiver or constructor) sits in the first slot and the arguments after it, so
/// `argv` points into the frame.
const SlotCall = struct { base: usize, parts: Parts, head: []const u8, argv: []const u8 };

fn beginSlotCall(e: *Emitter, expr: anytype, head: Expression, args: []const Expression, kind: []const u8) Error!SlotCall {
    const base = try requireCallBase(e, expr, kind);
    var parts: Parts = .empty;
    try e.beginCall(&parts, head, args, expr.span, base);
    return .{ .base = base, .parts = parts, .head = try e.slotAt(base), .argv = try argvAt(e, base, args.len) };
}

const ReceiverCall = struct { base: usize, receiver: []const u8, method: []const u8 };

/// The method is read into the slot after the arguments once they are evaluated, as JavaScript
/// orders a member call. `x` is a `DynMethodCall` or a `FieldCall`.
fn readReceiverMethod(e: *Emitter, x: anytype, kind: []const u8) Error!ReceiverCall {
    var call = try beginSlotCall(e, x, x.target, x.args, kind);
    const method = try e.slotAt(call.base + 1 + x.args.len);
    const read = switch (@TypeOf(x)) {
        *const nodes.DynMethodCall => try e.fmt("jsrt_get_prop({s}, {s}, &{s})", .{ call.head, try literals.cNameLiteral(e.arena, x.method), try e.icSite() }),
        *const nodes.FieldCall => try e.fmt("jsrt_object_get_field({s}, {d}, {s})", .{ call.head, x.slot, try literals.cNameLiteral(e.arena, x.field) }),
        else => @compileError("readReceiverMethod takes a receiver call"),
    };
    try call.parts.append(e.arena, try e.fmt("{s} = {s}", .{ method, read }));
    try e.flushParts(&call.parts, x.span);
    return .{ .base = call.base, .receiver = call.head, .method = method };
}

pub fn emitExpression(e: *Emitter, expr: Expression) Error![]const u8 {
    switch (expr) {
        .number_literal => |x| return e.fmt("jsrt_number({s})", .{try literals.cDoubleLiteral(e.arena, x.value)}),
        .string_literal => |x| return e.emitStringLiteral(x.value),
        .boolean_literal => |x| return e.fmt("jsrt_bool({s})", .{if (x.value) "true" else "false"}),
        .null_literal => return "JSRT_NULL",
        .undefined_literal => return "JSRT_UNDEFINED",
        .identifier => |x| return e.slotRef(x.name),
        .binary_op => |x| return e.emitBinaryOp(x),
        .unary_op => |x| {
            const slot = e.temp_slots.get(x) orelse
                return tables.unaryEmitter(e.arena, x.operator, try e.emitExpression(x.operand));
            const temp = try e.slotAt(slot);
            const operand = try e.emitExpression(x.operand);
            try e.line(x.span, "{s} = jsrt_number(jsrt_to_number({s}));", .{ temp, operand });
            try e.emitPendingCheck(x.span);
            return tables.unaryEmitter(e.arena, x.operator, temp);
        },
        .typeof => |x| return e.fmt("jsrt_typeof({s})", .{try e.emitExpression(x.operand)}),
        .reference_error => |x| return emitEffectValue(e, x.span, try e.fmt("jsrt_reference_error(\"{s}\")", .{try literals.escapeCString(e.arena, x.name)})),
        .type_error => |x| return emitEffectValue(e, x.span, try e.fmt("jsrt_throw_error(&jsrt_class_type_error, \"{s}\")", .{try literals.escapeCString(e.arena, x.message)})),
        .boundary_check => |x| {
            const check = tables.checkFunction(x.type.*) orelse
                return e.fail("no boundary check for type kind: {s}", .{@tagName(x.type.*)});
            const value = try e.emitExpression(x.value);
            return e.fmt("{s}({s}, \"{s}\")", .{ check, value, try literals.escapeCString(e.arena, x.where) });
        },
        .logical_op => |x| return e.emitLogicalOp(x),
        .conditional => |x| return e.emitConditional(x),
        .optional_chain => |x| return e.emitOptionalChain(x),
        .optional_base => return e.emitOptionalBase(),
        .update => |x| return e.emitUpdate(x),
        .template_literal => |x| return e.emitTemplateLiteral(x),
        .string_length => |x| return e.fmt("jsrt_number((double)jsrt_string_length({s}))", .{try e.emitExpression(x.operand)}),
        .function_length => |x| return e.fmt("jsrt_number((double)jsrt_closure_arity({s}))", .{try e.emitExpression(x.operand)}),
        .console_log => |x| {
            if (nodes.consoleMayThrow(x)) return emitEffectValue(e, x.span, try e.consoleCall(x));
            return e.fmt("({s}, JSRT_UNDEFINED)", .{try e.consoleCall(x)});
        },
        .function => |x| return e.closureValue(x),
        .array_length => |x| {
            const result = try e.slotAt(try e.slotOf(&e.temp_slots, x, "array length was not registered during counting"));
            return assignChecked(e, x.span, result, try e.fmt("jsrt_array_length({s})", .{try e.emitExpression(x.operand)}));
        },
        .array_literal => |x| {
            const base = e.array_slots.get(x) orelse return e.fail("array literal was not registered during counting", .{});
            if (x.elements.len == 0) return "jsrt_array_new(0, NULL)";
            var parts: Parts = .empty;
            var flushed = false;
            for (x.elements, 0..) |element, i| {
                flushed = (try e.sequenceAssign(&parts, element, x.span, base + i)) or flushed;
            }
            const alloc = try e.fmt("jsrt_array_new({d}, &{s})", .{ x.elements.len, try e.slotAt(base) });
            if (!flushed) {
                try parts.append(e.arena, alloc);
                return e.fmt("({s})", .{try e.join(parts.items)});
            }
            try e.flushParts(&parts, x.span);
            return alloc;
        },
        .index_access => |x| {
            var indexed = try requireIndexBase(e, x, "index access was not registered during counting");
            _ = try e.sequenceAssign(&indexed.parts, x.target, x.span, indexed.base);
            _ = try e.sequenceAssign(&indexed.parts, x.index, x.span, indexed.base + 1);
            const read = try helpers.indexGetCall(e.arena, x.target.getType(), indexed.target, indexed.second);
            try e.flushParts(&indexed.parts, x.span);
            return assignChecked(e, x.span, indexed.target, read);
        },
        .delete_prop => |x| {
            var indexed = try requireIndexBase(e, x, "delete was not registered during counting");
            _ = try e.sequenceAssign(&indexed.parts, x.target, x.span, indexed.base);
            _ = try e.sequenceAssign(&indexed.parts, x.key, x.span, indexed.base + 1);
            try e.flushParts(&indexed.parts, x.span);
            return assignChecked(e, x.span, indexed.target, try e.fmt("jsrt_bool(jsrt_delete({s}, {s}))", .{ indexed.target, indexed.second }));
        },
        .call => |x| {
            var call = try beginSlotCall(e, x, x.callee, x.args, "call");
            const loc = try e.callLocation(x.span);
            const invoke = if (x.spread == true)
                try e.fmt("jsrt_call_spread_at({s}, NULL, {s}, {s})", .{ call.head, try e.slotAt(call.base + 1), loc })
            else
                try e.fmt("jsrt_call_at({s}, {d}, {s}, {s})", .{ call.head, x.args.len, call.argv, loc });
            return e.finishStatement(&call.parts, try e.fmt("{s} = {s}", .{ call.head, invoke }), call.head, x.span);
        },
        .extern_call => |x| {
            const base = e.call_slots.get(x) orelse return e.fail("extern call was not registered during counting", .{});
            return e.emitExternCall(x, base);
        },
        .out_new => return "(jsrt_value)0",
        .out_get => |x| {
            const read = try e.emitExpression(x.operand);
            return if (x.inner == .pointer) read else e.fmt("jsrt_string_from_cstr((char *)jsrt_ptr({s}))", .{read});
        },
        .field_access => |x| {
            const target = try e.emitExpression(x.target);
            return e.fmt("jsrt_object_get_field({s}, {d}, {s})", .{ target, x.slot, try literals.cNameLiteral(e.arena, x.field) });
        },
        .iterator_next => |x| {
            const base = e.call_slots.get(x) orelse return e.fail("iterator-next was not registered during counting", .{});
            var parts: Parts = .empty;
            _ = try e.sequenceAssign(&parts, x.target, x.span, base);
            _ = try e.sequenceAssign(&parts, x.sent, x.span, base + 1);
            try e.flushParts(&parts, x.span);
            const step = switch (x.op) {
                .next => "jsrt_iterator_next",
                .@"return" => "jsrt_generator_close",
                .throw => "jsrt_generator_throw",
            };
            const result = try e.slotAt(base);
            return assignChecked(e, x.span, result, try e.fmt("{s}({s}, {s})", .{ step, result, try e.slotAt(base + 1) }));
        },
        .get_iterator => |x| {
            const result = try targetInTempSlot(e, x, "get-iterator was not registered during counting");
            return assignChecked(e, x.span, result, try e.fmt("jsrt_get_iterator({s})", .{result}));
        },
        .dyn_field_access => |x| {
            const result = try targetInTempSlot(e, x, "dynamic property read was not registered during counting");
            const name = try literals.cNameLiteral(e.arena, x.field);
            return assignChecked(e, x.span, result, try e.fmt("jsrt_get_prop({s}, {s}, &{s})", .{ result, name, try e.icSite() }));
        },
        .accessor_place => return e.fail("accessor-place emitted outside an update", .{}),
        .match_read => |x| {
            const target = try e.emitExpression(x.target);
            if (x.field == .length) return e.fmt("jsrt_array_length({s})", .{target});
            const name = try literals.cNameLiteral(e.arena, @tagName(x.field));
            return e.fmt("jsrt_get_prop({s}, {s}, &{s})", .{ target, name, try e.icSite() });
        },
        .regexp_read => |x| {
            const target = try e.emitExpression(x.target);
            if (nodes.REGEXP_FIELDS.get(x.field).flag) |flag| {
                return e.fmt("jsrt_bool(jsrt_regexp_flag({s}, '{c}'))", .{ target, flag });
            }
            return e.fmt("jsrt_regexp_{s}({s})", .{ try literals.snakeCase(e.arena, @tagName(x.field)), target });
        },
        .new => |x| {
            const base = e.call_slots.get(x) orelse return e.fail("new was not registered during counting", .{});
            const class = try e.classAt(x.class_name);
            const object = try e.slotAt(base);
            var parts: Parts = .empty;
            try parts.append(e.arena, try e.fmt("{s} = jsrt_object_new(&_jsrt_class_{d})", .{ object, e.class_ids.get(x.class_name).? }));
            _ = try e.sequenceArgs(&parts, x.args, x.span, base, 1);
            const ctor = class.ctor orelse {
                try e.flushParts(&parts, x.span);
                return object;
            };
            const call = try e.fmt("jsrt_call({s}, {d}, &{s})", .{ try e.closureValue(ctor.@"fn"), 1 + x.args.len, object });
            return e.finishStatement(&parts, call, object, x.span);
        },
        .method_value => |x| {
            if (x.dispatch == .virtual) {
                return e.fmt("jsrt_method({s}, {d})", .{ try e.emitExpression(x.target), x.slot });
            }
            const callee = try e.closureValue((try findClassMethod(e, x.class_name, x.method)).@"fn");
            const captured = try e.captureExpression(x.target);
            if (captured.lines.len == 0) return e.fmt("({s}, {s})", .{ captured.value, callee });
            try e.pushLines(captured.lines);
            return callee;
        },
        .method_call => |x| {
            var call = try beginSlotCall(e, x, x.target, x.args, "method call");
            const receiver = call.head;
            const callee = if (x.dispatch == .virtual)
                try e.fmt("jsrt_method({s}, {d})", .{ receiver, x.slot })
            else
                try e.methodCallee(x, receiver);
            const invoke = try e.fmt("{s} = jsrt_call({s}, {d}, &{s})", .{ receiver, callee, 1 + x.args.len, receiver });
            return e.finishStatement(&call.parts, invoke, receiver, x.span);
        },
        .dyn_method_call => |x| {
            const call = try readReceiverMethod(e, x, "dyn-method-call");
            try e.emitPendingCheck(x.span);
            if (x.not_function) |not_function| {
                const message = try literals.escapeCString(e.arena, try e.fmt("{s} is not a function", .{not_function}));
                try e.line(x.span, "if (!jsrt_is({s}, JSRT_TAG_CLOSURE)) {{ jsrt_throw_error(&jsrt_class_type_error, \"{s}\"); }}", .{ call.method, message });
                try e.emitPendingCheck(x.span);
            }
            if (x.spread == true) {
                const loc = try e.callLocation(x.span);
                var none: Parts = .empty;
                const invoke = try e.fmt("{s} = jsrt_call_spread_at({s}, &{s}, {s}, {s})", .{ call.receiver, call.method, call.receiver, try e.slotAt(call.base + 1), loc });
                return e.finishStatement(&none, invoke, call.receiver, x.span);
            }
            return finishReceiverCall(e, call.base, call.method, x.args.len, x.span);
        },
        .field_call => |x| {
            const call = try readReceiverMethod(e, x, "field-call");
            return finishReceiverCall(e, call.base, call.method, x.args.len, x.span);
        },
        .object_literal => |x| return emitObjectLiteral(e, x),
        .dyn_object_literal => |x| return emitDynObjectLiteral(e, x),
        .collection_new => |x| {
            if (x.weak) return e.fmt("jsrt_weak_collection_new({s})", .{if (x.collection == .map) "true" else "false"});
            return e.fmt("jsrt_{s}_new()", .{@tagName(x.collection)});
        },
        .regexp_literal => |x| {
            const base = e.call_slots.get(x) orelse return e.fail("regexp literal was not registered during counting", .{});
            const slot = try e.slotAt(base);
            const source = try e.emitStringLiteral(x.source);
            return e.fmt("({s} = {s}, jsrt_regexp_new({s}, {s}))", .{ slot, source, slot, try e.emitStringLiteral(x.flags) });
        },
        .date_new => |x| return emitUnaryCall(e, x, "date-new", "jsrt_date_from_value", "", false),
        .error_new => |x| {
            const leading = try e.fmt("&{s}, ", .{nodes.errorDescriptor(x.ctor)});
            return emitUnaryCall(e, x, "error-new", "jsrt_error_new", leading, false);
        },
        .json_parse => |x| return emitUnaryCall(e, x, "json-parse", "jsrt_json_parse", "", false),
        .json_stringify => |x| return emitUnaryCall(e, x, "json-stringify", "jsrt_json_stringify", "", true),
        .promise_static => |x| {
            const name = try e.fmt("jsrt_promise_{s}", .{@tagName(x.method)});
            return emitUnaryCall(e, x, "promise-static", name, "", false);
        },
        .promise_construct => |x| {
            const base = e.call_slots.get(x) orelse return e.fail("promise-construct was not registered during counting", .{});
            e.used_async = true;
            var parts: Parts = .empty;
            _ = try e.sequenceAssign(&parts, x.executor, x.span, base);
            const slot = try e.slotAt(base);
            return e.finishStatement(&parts, try e.fmt("{s} = jsrt_promise_construct({s})", .{ slot, slot }), slot, x.span);
        },
        .promise_method => |x| {
            e.used_async = true;
            var call = try beginSlotCall(e, x, x.target, x.args, "promise-method");
            const function = switch (x.method) {
                .then => "jsrt_promise_then",
                .@"catch" => "jsrt_promise_catch",
                .finally => "jsrt_promise_finally",
            };
            const operands = try slotOperands(e, call.base, x.args.len + 1);
            try call.parts.append(e.arena, try e.fmt("{s} = {s}({s})", .{ call.head, function, operands }));
            try e.flushParts(&call.parts, x.span);
            return call.head;
        },
        .collection_op => |x| {
            var op = try sequenceTargetOperands(e, x, "collection-op", false);
            const call = (try helpers.collectionIteratorBoxCall(e.arena, x.collection, x.op, op.operands)) orelse
                try helpers.collectionCall(e.arena, x.op, x.collection, op.operands);
            return e.finishOp(&op.parts, op.base, call, x.span, op.flushed, x.op == .forEach or helpers.mayRefuseWeakKey(x));
        },
        .array_op => |x| {
            var op = try sequenceTargetOperands(e, x, "array-op", false);
            const call = (try helpers.arrayIteratorBoxCall(e.arena, x.op, op.operands)) orelse try e.arrayOpCall(x, op.base);
            return e.finishOp(&op.parts, op.base, call, x.span, op.flushed, true);
        },
        .date_op => |x| {
            var op = try sequenceTargetOperands(e, x, "date-op", false);
            const call = try e.fmt("{s}({s})", .{ nodes.DATE_OPS.get(x.op).@"fn", op.operands });
            return e.finishOp(&op.parts, op.base, call, x.span, op.flushed, x.op == .toISOString or helpers.argsConvert(x.args));
        },
        .number_op => |x| {
            var op = try sequenceTargetOperands(e, x, "number-op", false);
            const call = try e.fmt("{s}({s})", .{ nodes.NUMBER_OPS.get(x.op).@"fn", op.operands });
            return e.finishOp(&op.parts, op.base, call, x.span, op.flushed, true);
        },
        .regexp_op => |x| {
            var op = try sequenceTargetOperands(e, x, "regexp-op", false);
            const name = try literals.snakeCase(e.arena, @tagName(x.op));
            const call = if (nodes.REGEXP_OPS.get(x.op).result == .boolean)
                try e.fmt("jsrt_bool(jsrt_regexp_{s}({s}))", .{ name, op.operands })
            else
                try e.fmt("jsrt_regexp_{s}({s})", .{ name, op.operands });
            return e.finishOp(&op.parts, op.base, call, x.span, op.flushed, helpers.argsConvert(x.args));
        },
        .string_op => |x| {
            var op = try sequenceTargetOperands(e, x, "string-op", x.op == .concat);
            const call = try e.fmt("jsrt_string_{s}({s})", .{ try literals.snakeCase(e.arena, @tagName(x.op)), op.operands });
            return e.finishOp(&op.parts, op.base, call, x.span, op.flushed, nodes.stringOpCanThrow(x.op) or helpers.argsConvert(x.args));
        },
        .date_components => |x| return emitNamedCall(e, x, "date-components", "jsrt_date_from_components", helpers.argsConvert(x.args)),
        .date_static => |x| return emitNamedCall(e, x, "date-static", nodes.DATE_STATICS.get(x.method).@"fn", helpers.argsConvert(x.args)),
        .global_call => |x| {
            const info = nodes.GLOBAL_CALLS.get(x.name);
            return emitNamedCall(e, x, "global-call", info.@"fn", info.throws or helpers.argsConvert(x.args));
        },
        .typed_op => |x| return emitNamedCall(e, x, "typed-op", nodes.TYPED_OPS.get(x.op).@"fn", true),
        .object_static => |x| {
            const name = try e.fmt("jsrt_object_{s}", .{try literals.snakeCase(e.arena, @tagName(x.method))});
            return emitNamedCall(e, x, "object-static", name, true);
        },
        .math_call => |x| {
            const name = try e.fmt("jsrt_math_{s}", .{@tagName(x.method)});
            if (e.call_slots.get(x) == null) {
                var operands: Parts = .empty;
                for (x.args) |arg| try operands.append(e.arena, try e.emitExpression(arg));
                return e.fmt("{s}({s})", .{ name, try e.join(operands.items) });
            }
            return emitNamedCall(e, x, "math-call", name, helpers.argsConvert(x.args));
        },
        .string_static => |x| {
            const name = "jsrt_string_from_char_code";
            if (e.call_slots.get(x) == null) {
                var operands: Parts = .empty;
                for (x.args) |arg| try operands.append(e.arena, try e.emitExpression(arg));
                const joined = try e.join(operands.items);
                if (joined.len == 0) return e.fmt("{s}(0)", .{name});
                return e.fmt("{s}({d}, {s})", .{ name, x.args.len, joined });
            }
            var op = try sequenceCallOperands(e, x, "string-static");
            const call = try e.fmt("{s}({d}, {s})", .{ name, x.args.len, op.operands });
            return e.finishOp(&op.parts, op.base, call, x.span, op.flushed, helpers.argsConvert(x.args));
        },
        .await => |x| {
            if (!e.in_async) return e.fail("await outside an async function; the gate should have caught it", .{});
            const park = try e.fmt("jsrt_await(_jsrt_self, {s});", .{try e.suspendSlot(expr)});
            const at = try e.emitPark(expr, x.value, park);
            try e.line(x.span, "if (_jsrt_err) {{ jsrt_throw(_jsrt_v); goto {s}; }}", .{try e.currentPad()});
            try e.line(x.span, "{s} = _jsrt_v;", .{at});
            return at;
        },
        .yield => |x| {
            if (!e.in_generator) return e.fail("yield outside a generator; the gate should have caught it", .{});
            const park = try e.fmt("jsrt_generator_yield(_jsrt_self, {s});", .{try e.suspendSlot(expr)});
            const at = try e.emitPark(expr, x.value, park);
            try e.openBlock("if (_jsrt_self->inject == JSRT_GEN_INJECT_THROW) {", x.span);
            try e.appendLine("_jsrt_self->inject = JSRT_GEN_INJECT_NONE;", x.span);
            try e.appendLine("jsrt_throw(_jsrt_v);", x.span);
            try e.line(x.span, "goto {s};", .{try e.currentPad()});
            try e.closeBlock(x.span);
            try e.openBlock("if (_jsrt_self->inject == JSRT_GEN_INJECT_RETURN) {", x.span);
            try e.appendLine("_jsrt_self->inject = JSRT_GEN_INJECT_NONE;", x.span);
            try e.line(x.span, "{s} = _jsrt_v;", .{try e.slotAt(e.return_slot)});
            try e.emitReturnJump(x.span);
            try e.closeBlock(x.span);
            try e.line(x.span, "{s} = _jsrt_v;", .{at});
            return at;
        },
        .instanceof => |x| {
            if (x.builtin == true) {
                const target = try e.emitExpression(x.target);
                return e.fmt("jsrt_bool(jsrt_instanceof_builtin({s}, {s}))", .{ target, try literals.cNameLiteral(e.arena, x.class_name) });
            }
            _ = try e.classAt(x.class_name);
            const id = e.class_ids.get(x.class_name).?;
            return e.fmt("jsrt_bool(jsrt_instanceof({s}, &_jsrt_class_{d}))", .{ try e.emitExpression(x.target), id });
        },
        .new_value => |x| {
            var call = try beginSlotCall(e, x, x.target, x.args, "new-value");
            const construct = try e.fmt("{s} = jsrt_construct({s}, {d}, {s})", .{ call.head, call.head, x.args.len, call.argv });
            return e.finishStatement(&call.parts, construct, call.head, x.span);
        },
        .instanceof_value => |x| {
            var call = try beginSlotCall(e, x, x.target, &.{x.ctor}, "instanceof-value");
            const check = try e.fmt("{s} = jsrt_bool(jsrt_instanceof_ctor({s}, {s}))", .{ call.head, call.head, try e.slotAt(call.base + 1) });
            return e.finishStatement(&call.parts, check, call.head, x.span);
        },
        .class_value => |x| {
            _ = try e.classAt(x.class_name);
            return e.fmt("jsrt_closure(&_jsrt_class_object_{d})", .{e.class_ids.get(x.class_name).?});
        },
    }
}

/// The receiver question is a runtime one: a plain property read can hold either kind of closure.
fn finishReceiverCall(e: *Emitter, base: usize, method: []const u8, count: usize, span: Span) Error![]const u8 {
    const receiver = try e.slotAt(base);
    const argv = try argvAt(e, base, count);
    const loc = try e.callLocation(span);
    const with_receiver = try e.fmt("jsrt_call_at({s}, {d}, &{s}, {s})", .{ method, 1 + count, receiver, loc });
    const without_receiver = try e.fmt("jsrt_call_at({s}, {d}, {s}, {s})", .{ method, count, argv, loc });
    var none: Parts = .empty;
    const call = try e.fmt("{s} = (jsrt_is({s}, JSRT_TAG_CLOSURE) && jsrt_as_closure({s})->has_receiver) ? {s} : {s}", .{ receiver, method, method, with_receiver, without_receiver });
    return e.finishStatement(&none, call, receiver, span);
}

fn emitUnaryCall(e: *Emitter, expr: anytype, kind: []const u8, call: []const u8, leading: []const u8, can_throw: bool) Error![]const u8 {
    const base = try requireCallBase(e, expr, kind);
    var parts: Parts = .empty;
    const flushed = try e.sequenceAssign(&parts, expr.arg, expr.span, base);
    if (@TypeOf(expr) == *const nodes.PromiseStaticCall) e.used_async = true;
    const op_call = try e.fmt("{s}({s}{s})", .{ call, leading, try e.slotAt(base) });
    return e.finishOp(&parts, base, op_call, expr.span, flushed, can_throw);
}

fn emitNamedCall(e: *Emitter, expr: anytype, kind: []const u8, name: []const u8, can_throw: bool) Error![]const u8 {
    var op = try sequenceCallOperands(e, expr, kind);
    const call = try e.fmt("{s}({s})", .{ name, op.operands });
    return e.finishOp(&op.parts, op.base, call, expr.span, op.flushed, can_throw);
}

fn sequenceTargetOperands(e: *Emitter, expr: anytype, kind: []const u8, coercing_concat: bool) Error!Sequenced {
    const base = try requireCallBase(e, expr, kind);
    var parts: Parts = .empty;
    var flushed = try e.sequenceAssign(&parts, expr.target, expr.span, base);
    flushed = (try e.sequenceArgs(&parts, expr.args, expr.span, base, 1)) or flushed;
    var operands: Parts = .empty;
    try operands.append(e.arena, try e.slotAt(base));
    for (0..expr.args.len) |index| {
        const slot = try e.slotAt(base + 1 + index);
        try operands.append(e.arena, if (coercing_concat) try e.fmt("jsrt_to_string({s})", .{slot}) else slot);
    }
    return .{ .base = base, .parts = parts, .flushed = flushed, .operands = try e.join(operands.items) };
}

/// The first of `items` (any slice of structs with a `name`) called `name`.
fn indexByName(items: anytype, name: []const u8) ?usize {
    for (items, 0..) |item, index| {
        if (std.mem.eql(u8, item.name, name)) return index;
    }
    return null;
}

fn orderSuffix(e: *Emitter, order: ?[]const usize) Error![]const u8 {
    const slots = order orelse return "";
    var joined: std.ArrayList(u8) = .empty;
    try joined.append(e.arena, '#');
    for (slots, 0..) |slot, index| {
        if (index > 0) try joined.append(e.arena, ',');
        try joined.print(e.arena, "{d}", .{slot});
    }
    return joined.items;
}

/// The class a literal registers under: two key orders are two shapes.
fn shapeClassName(e: *Emitter, shape: *const types.HObject, order: ?[]const usize) Error![]const u8 {
    return e.fmt("{s}{s}", .{ shape.name, try orderSuffix(e, order) });
}

const SpreadCopy = struct {
    expr: *const nodes.ObjectLiteral,
    slot: usize,
    hidden_at: *const std.StringArrayHashMapUnmanaged(usize),
    scratch: *emitter.SpreadState,
    parts: *Parts,
    flushed: *bool,

    fn emit(self: SpreadCopy, e: *Emitter, copy: nodes.MethodCopy) Error!void {
        const dst = self.hidden_at.get(copy.name) orelse
            return e.fail("spread method {s} is not in its own shape", .{copy.name});
        const receiver = copy.value.target;
        const receiver_type = receiver.getType();
        if (receiver_type.* != .object) return e.fail("spread method {s} has no source shape", .{copy.name});
        const source = receiver_type.object;
        const method_index = indexByName(source.methods, copy.name) orelse
            return e.fail("spread method {s} is not in its source shape", .{copy.name});
        const src = source.fields.len + method_index;
        const from = if (receiver == .identifier) blk: {
            const rendered = try e.captureExpression(receiver);
            if (rendered.lines.len > 0) return e.fail("spread copy source produced statements", .{});
            break :blk rendered.value;
        } else blk: {
            const key = try helpers.spreadScratchKey(e.arena, copy.value.span);
            const resolved = try e.spreadSource(self.parts, key, self.scratch, self.expr.span, self.flushed.*);
            self.flushed.* = resolved.flushed;
            break :blk resolved.slot orelse return e.fail("spread copy source has no slot", .{});
        };
        try self.parts.append(e.arena, try e.fmt("jsrt_object_set({s}, {d}, jsrt_object_get_field({s}, {d}, {s}))", .{
            try e.slotAt(self.slot),
            dst,
            from,
            src,
            try literals.cNameLiteral(e.arena, copy.name),
        }));
    }
};

fn spreadState(e: *Emitter, groups: []const helpers.SpreadGroup, first_slot: usize) Error!emitter.SpreadState {
    var state: emitter.SpreadState = .{};
    for (groups, 0..) |group, index| {
        try state.at.put(e.arena, group.key, first_slot + index);
        try state.target.put(e.arena, group.key, group.target);
    }
    return state;
}

fn emitObjectLiteral(e: *Emitter, x: *const nodes.ObjectLiteral) Error![]const u8 {
    const slot = e.call_slots.get(x) orelse return e.fail("object literal was not registered during counting", .{});
    const shape = helpers.shapeOf(x) orelse return e.fail("object literal has no object type", .{});
    const layout = shape.fields;
    const order = try helpers.keyOrderOf(e.arena, x, layout);
    const name = try shapeClassName(e, shape, order);
    const id = e.class_ids.get(name) orelse return e.fail("object literal was not registered during counting", .{});
    const scratches = try helpers.spreadScratches(e.arena, x.entries, x.method_copies);
    var scratch = try spreadState(e, scratches, slot + 1);
    var needs_order = false;
    if (layout.len > 0) {
        for (x.entries) |entry| {
            if (entry.spread == true) needs_order = true;
        }
    }
    const snaps = try helpers.spreadSnapshots(e.arena, x.entries);
    const snap = try spreadState(e, snaps, slot + 1 + scratches.len);
    var snap_done: emitter.StringSet = .empty;
    const order_id = e.spread_order_count;
    if (needs_order) e.spread_order_count += 1;
    const result = try e.slotAt(slot);
    var parts: Parts = .empty;
    try parts.append(e.arena, try e.fmt("{s} = jsrt_object_new(&_jsrt_class_{d})", .{ result, id }));
    var flushed = false;
    var hidden_at: std.StringArrayHashMapUnmanaged(usize) = .empty;
    for (shape.methods, 0..) |method, index| try hidden_at.put(e.arena, method.name, layout.len + index);
    var copies_at: std.AutoArrayHashMapUnmanaged(u32, std.ArrayList(nodes.MethodCopy)) = .empty;
    for (x.method_copies) |copy| {
        const group = try copies_at.getOrPutValue(e.arena, copy.at, .empty);
        try group.value_ptr.append(e.arena, copy);
    }
    const copier: SpreadCopy = .{
        .expr = x,
        .slot = slot,
        .hidden_at = &hidden_at,
        .scratch = &scratch,
        .parts = &parts,
        .flushed = &flushed,
    };
    for (x.entries, 0..) |entry, index| {
        if (copies_at.get(@intCast(index))) |group| {
            for (group.items) |copy| try copier.emit(e, copy);
        }
        const target = indexByName(layout, entry.name) orelse
            return e.fail("object literal key {s} is not in its own shape", .{entry.name});
        if (needs_order and entry.spread == true and entry.value == .field_access and entry.value.field_access.target == .identifier) {
            const key = try helpers.spreadScratchKey(e.arena, entry.value.field_access.span);
            if (!snap_done.contains(key)) {
                try snap_done.put(e.arena, key, {});
                const snap_slot = snap.at.get(key) orelse return e.fail("spread snapshot has no slot", .{});
                const source = snap.target.get(key) orelse return e.fail("spread snapshot has no slot", .{});
                const rendered = try e.captureExpression(source);
                if (rendered.lines.len > 0) return e.fail("spread snapshot source produced statements", .{});
                try parts.append(e.arena, try e.fmt("{s} = {s}", .{ try e.slotAt(snap_slot), rendered.value }));
            }
        }
        if (entry.value == .field_access and entry.value.field_access.target != .identifier) {
            const read = entry.value.field_access;
            const key = try helpers.spreadScratchKey(e.arena, read.span);
            const resolved = try e.spreadSource(&parts, key, &scratch, x.span, flushed);
            flushed = resolved.flushed;
            if (resolved.slot) |source| {
                try parts.append(e.arena, try e.fmt("jsrt_object_set({s}, {d}, jsrt_object_get_field({s}, {d}, {s}))", .{
                    result,
                    target,
                    source,
                    read.slot,
                    try literals.cNameLiteral(e.arena, entry.name),
                }));
                continue;
            }
        }
        flushed = (try e.sequencePart(&parts, entry.value, x.span, .{
            .prefix = try e.fmt("jsrt_object_set({s}, {d}, ", .{ result, target }),
            .suffix = ")",
        })) or flushed;
    }
    if (copies_at.get(@intCast(x.entries.len))) |group| {
        for (group.items) |copy| try copier.emit(e, copy);
    }
    for (x.methods) |method| {
        const dst = hidden_at.get(method.name) orelse
            return e.fail("object literal method {s} is not in its own shape", .{method.name});
        try parts.append(e.arena, try e.fmt("jsrt_object_set({s}, {d}, {s})", .{ result, dst, try e.closureValue(method.@"fn") }));
    }
    if (needs_order) {
        try e.flushParts(&parts, x.span);
        const span = x.span;
        const width = layout.len;
        try e.line(span, "uint32_t _jsrt_order_{d}[{d}];", .{ order_id, width });
        try e.line(span, "uint32_t _jsrt_ordn_{d} = 0;", .{order_id});
        var order_seen: emitter.StringSet = .empty;
        for (x.entries) |entry| {
            if (entry.spread == true) {
                if (entry.value != .field_access) return e.fail("spread order entry is not a field read", .{});
                const key = try helpers.spreadScratchKey(e.arena, entry.value.field_access.span);
                if (order_seen.contains(key)) continue;
                try order_seen.put(e.arena, key, {});
                const source_slot = scratch.at.get(key) orelse snap.at.get(key) orelse
                    return e.fail("spread order source has no slot", .{});
                try e.line(span, "jsrt_spread_order_src(_jsrt_order_{d}, &_jsrt_ordn_{d}, {d}, {s}, {s});", .{ order_id, order_id, width, result, try e.slotAt(source_slot) });
            } else {
                const dst = indexByName(layout, entry.name) orelse
                    return e.fail("object literal key {s} is not in its own shape", .{entry.name});
                try e.line(span, "jsrt_spread_order_key(_jsrt_order_{d}, &_jsrt_ordn_{d}, {d}, {d});", .{ order_id, order_id, width, dst });
            }
        }
        try e.line(span, "{s} = jsrt_object_set_order({s}, _jsrt_order_{d}, _jsrt_ordn_{d});", .{ result, result, order_id, order_id });
        return result;
    }
    return e.finishSequenced(&parts, result, x.span, flushed);
}

fn emitAccessorHalf(e: *Emitter, parts: *Parts, function: ?Expression, next: *usize, span: Span, flushed: *bool) Error![]const u8 {
    const value = function orelse return "JSRT_UNDEFINED";
    const into = try e.slotAt(next.*);
    const slot = next.*;
    next.* += 1;
    flushed.* = (try e.sequenceAssign(parts, value, span, slot)) or flushed.*;
    return into;
}

fn emitDynObjectLiteral(e: *Emitter, x: *const nodes.DynObjectLiteral) Error![]const u8 {
    const slot = e.call_slots.get(x) orelse return e.fail("dynamic object literal was not registered during counting", .{});
    const result = try e.slotAt(slot);
    const value_scratch = try e.slotAt(slot + 1);
    const scratches = try helpers.spreadScratches(e.arena, x.entries, &.{});
    const base = slot + helpers.dynLiteralBaseSlots(x);
    var scratch = try spreadState(e, scratches, base);
    var parts: Parts = .empty;
    try parts.append(e.arena, try e.fmt("{s} = jsrt_dynobj_new()", .{result}));
    var flushed = false;
    for (x.entries) |item| switch (item) {
        .accessor_entry => |entry| {
            var next = slot + 1;
            const get = try emitAccessorHalf(e, &parts, entry.get, &next, x.span, &flushed);
            const set = try emitAccessorHalf(e, &parts, entry.set, &next, x.span, &flushed);
            try parts.append(e.arena, try e.fmt("jsrt_define_accessor({s}, {s}, {s}, {s})", .{ result, try literals.cNameLiteral(e.arena, entry.name), get, set }));
        },
        .computed_entry => |entry| {
            flushed = (try e.sequenceAssign(&parts, entry.key, x.span, slot + 1)) or flushed;
            flushed = (try e.sequenceAssign(&parts, entry.value, x.span, slot + 2)) or flushed;
            try parts.append(e.arena, try e.fmt("jsrt_dyn_index_set({s}, {s}, {s}, NULL)", .{ result, value_scratch, try e.slotAt(slot + 2) }));
        },
        .object_entry => |entry| {
            if (entry.proto_setter == true) {
                flushed = (try e.sequenceAssign(&parts, entry.value, x.span, slot + 1)) or flushed;
                continue;
            }
            if (entry.spread == true) {
                if (entry.value != .field_access) return e.fail("spread entry is not a field read", .{});
                const read = entry.value.field_access;
                const key = try helpers.spreadScratchKey(e.arena, read.span);
                if (scratch.done.contains(key)) continue;
                try scratch.done.put(e.arena, key, {});
                if (scratch.at.get(key)) |scratch_slot| {
                    const source = scratch.target.get(key) orelse return e.fail("spread source has no scratch target", .{});
                    flushed = (try e.sequenceAssign(&parts, source, x.span, scratch_slot)) or flushed;
                    try parts.append(e.arena, try e.fmt("{s} = jsrt_dynobj_spread({s}, {s})", .{ result, result, try e.slotAt(scratch_slot) }));
                } else {
                    if (read.target != .identifier) return e.fail("spread source has no scratch slot", .{});
                    const rendered = try e.captureExpression(read.target);
                    if (rendered.lines.len > 0) return e.fail("spread source produced statements", .{});
                    try parts.append(e.arena, try e.fmt("{s} = jsrt_dynobj_spread({s}, {s})", .{ result, result, rendered.value }));
                }
                continue;
            }
            flushed = (try e.sequenceAssign(&parts, entry.value, x.span, slot + 1)) or flushed;
            try parts.append(e.arena, try e.fmt("jsrt_set_prop({s}, {s}, {s}, NULL)", .{ result, try literals.cNameLiteral(e.arena, entry.name), value_scratch }));
        },
    };
    return e.finishSequenced(&parts, result, x.span, flushed);
}

pub fn registerShape(e: *Emitter, x: *const nodes.ObjectLiteral) Error!void {
    const shape = helpers.shapeOf(x) orelse return e.fail("object literal has no object type", .{});
    const layout = shape.fields;
    const order = try helpers.keyOrderOf(e.arena, x, layout);
    const name = try shapeClassName(e, shape, order);
    if (e.class_ids.contains(name)) return;
    const id = e.classes.items.len;
    try e.class_ids.put(e.arena, name, id);
    var fields: std.ArrayList(nodes.Parameter) = .empty;
    for (layout) |field| try fields.append(e.arena, .{ .name = field.name, .type = field.type, .span = x.span });
    if (shape.methods.len > 0) {
        var full: std.ArrayList(usize) = .empty;
        if (order) |slots| {
            try full.appendSlice(e.arena, slots);
        } else {
            for (0..layout.len) |index| try full.append(e.arena, index);
        }
        var hidden: emitter.HiddenMethods = .empty;
        for (shape.methods, 0..) |method, index| {
            try hidden.put(e.arena, method.name, layout.len + index);
            try full.append(e.arena, layout.len + index);
            try fields.append(e.arena, .{
                .name = try literals.hiddenMethodField(e.arena, method.name),
                .type = ownMethodType(x, method.name) orelse method.type,
                .span = x.span,
            });
        }
        try e.class_key_orders.put(e.arena, id, full.items);
        try e.class_hidden_methods.put(e.arena, shape.name, hidden);
    } else if (order) |slots| {
        try e.class_key_orders.put(e.arena, id, slots);
    }
    const class = try e.arena.create(nodes.ClassDeclaration);
    class.* = .{
        .type = x.type,
        .span = x.span,
        .name = name,
        .fields = fields.items,
        .methods = x.methods,
    };
    try e.classes.append(e.arena, class);
}

/// A `Map` built from the list keeps the last entry for a repeated name.
fn ownMethodType(x: *const nodes.ObjectLiteral, name: []const u8) ?*const HType {
    var index = x.methods.len;
    while (index > 0) {
        index -= 1;
        if (std.mem.eql(u8, x.methods[index].name, name)) return x.methods[index].@"fn".type;
    }
    return null;
}

fn findMethodIn(class: *const nodes.ClassDeclaration, name: []const u8) ?nodes.ClassMethod {
    return class.methods[indexByName(class.methods, name) orelse return null];
}

fn findClassMethod(e: *Emitter, class_name: []const u8, method_name: []const u8) Error!nodes.ClassMethod {
    return findMethodIn(try e.classAt(class_name), method_name) orelse
        e.fail("class {s} has no method {s}", .{ class_name, method_name });
}

pub fn methodOf(e: *Emitter, expr: *const nodes.MethodCall) Error!nodes.ClassMethod {
    return findClassMethod(e, expr.class_name, expr.method);
}

pub fn methodCallee(e: *Emitter, expr: *const nodes.MethodCall, receiver: []const u8) Error![]const u8 {
    if (e.class_hidden_methods.get(expr.class_name)) |hidden_methods| {
        if (hidden_methods.get(expr.method)) |hidden| {
            return e.fmt("jsrt_object_get_field({s}, {d}, {s})", .{ receiver, hidden, try literals.cNameLiteral(e.arena, expr.method) });
        }
    }
    return e.closureValue((try e.methodOf(expr)).@"fn");
}

fn accessorCallee(e: *Emitter, place: *const nodes.AccessorPlace, half: []const u8) Error![]const u8 {
    const method = try e.fmt("{s} {s}", .{ half, place.property });
    const found = findMethodIn(try e.classAt(place.owner), method) orelse
        return e.fail("class {s} has no method {s}", .{ place.owner, method });
    return e.closureValue(found.@"fn");
}

pub fn methodIdOrNull(e: *Emitter, entry: nodes.VtableEntry) Error!?usize {
    const method = try findClassMethod(e, entry.class_name, entry.name);
    if (method.@"fn".needs_env) return null;
    return try e.functionId(method.@"fn");
}

pub fn baseDescriptor(e: *Emitter, class: *const nodes.ClassDeclaration, id: usize) Error![]const u8 {
    const base = class.base orelse return "NULL";
    const base_id = e.class_ids.get(base);
    if (base_id == null or base_id.? >= id) {
        return e.fail("class {s} is emitted before its base {s}", .{ class.name, base });
    }
    return e.fmt("&_jsrt_class_{d}", .{base_id.?});
}

pub fn classAt(e: *Emitter, name: []const u8) Error!*const nodes.ClassDeclaration {
    const id = e.class_ids.get(name) orelse
        return e.fail("class {s} was not registered during counting", .{name});
    if (id >= e.classes.items.len) return e.fail("class {s} was not registered during counting", .{name});
    return e.classes.items[id];
}

pub fn emitTemplateLiteral(e: *Emitter, expr: *const nodes.TemplateLiteral) Error![]const u8 {
    const slots = e.template_slots.get(expr) orelse
        return e.fail("template literal has no frame slots; countExpression missed a node", .{});
    var sequence: Parts = .empty;
    var flushed = false;
    var part_index: usize = 0;
    for (expr.quasis, 0..) |quasi, i| {
        if (quasi.len != 0) {
            try sequence.append(e.arena, try e.fmt("{s} = {s}", .{ try e.slotAt(slots.base + part_index), try e.emitStringLiteral(quasi) }));
            part_index += 1;
        }
        if (i < expr.expressions.len) {
            const hole = expr.expressions[i];
            const hole_slot = try e.slotAt(slots.base + part_index);
            flushed = (try e.sequencePart(&sequence, hole, expr.span, .{
                .prefix = try e.fmt("{s} = jsrt_to_string(", .{hole_slot}),
                .suffix = ")",
            })) or flushed;
            if (hTypeConversionRunsUserCode(hole.getType())) {
                try e.flushParts(&sequence, expr.span);
                try e.emitPendingCheck(expr.span);
                flushed = true;
            }
            part_index += 1;
        }
    }
    if (part_index != slots.count) return e.fail("template literal part count disagrees with its frame-slot count", .{});
    const first = try e.slotAt(slots.base);
    var index: usize = 1;
    while (index < part_index) : (index += 1) {
        try sequence.append(e.arena, try e.fmt("{s} = jsrt_string_concat({s}, {s})", .{ first, first, try e.slotAt(slots.base + index) }));
    }
    if (part_index > 1) {
        try e.flushParts(&sequence, expr.span);
        try e.emitPendingCheck(expr.span);
        return first;
    }
    if (!flushed) {
        try sequence.append(e.arena, first);
        return e.fmt("({s})", .{try e.join(sequence.items)});
    }
    try e.flushParts(&sequence, expr.span);
    return first;
}

pub fn emitToNumber(e: *Emitter, slot: []const u8, value_type: *const HType, span: Span) Error!void {
    if (hTypeConversionRunsUserCode(value_type)) {
        try e.line(span, "{s} = jsrt_number(jsrt_to_number({s}));", .{ slot, slot });
        try e.emitPendingCheck(span);
    }
}

pub fn emitBinaryOp(e: *Emitter, expr: *const nodes.BinaryOp) Error![]const u8 {
    const base = e.binary_slots.get(expr) orelse
        return e.fail("binary operator has no frame slots; countExpression missed a node", .{});
    const left = try e.slotAt(base);
    const right = try e.slotAt(base + 1);
    var parts: Parts = .empty;
    _ = try e.sequenceAssign(&parts, expr.left, expr.span, base);
    _ = try e.sequenceAssign(&parts, expr.right, expr.span, base + 1);
    if (expr.operator == .in) {
        try e.flushParts(&parts, expr.span);
        return assignChecked(e, expr.span, left, try e.fmt("jsrt_bool(jsrt_in({s}, {s}))", .{ left, right }));
    }
    const converts = expr.operator != .@"," and expr.operator != .@"===" and expr.operator != .@"!==" and
        (hTypeConversionRunsUserCode(expr.left.getType()) or hTypeConversionRunsUserCode(expr.right.getType()));
    if (converts and tables.isNumericBinaryOperator(expr.operator)) {
        try e.flushParts(&parts, expr.span);
        try e.emitToNumber(left, expr.left.getType(), expr.span);
        try e.emitToNumber(right, expr.right.getType(), expr.span);
        return tables.binaryEmitter(e.arena, expr.operator, left, right);
    }
    if ((expr.operator == .@"+" and expr.type.* != .number) or converts) {
        try e.flushParts(&parts, expr.span);
        return assignChecked(e, expr.span, left, try tables.binaryEmitter(e.arena, expr.operator, left, right));
    }
    const result = try tables.binaryEmitter(e.arena, expr.operator, left, right);
    if (parts.items.len == 2) return e.fmt("({s}, {s})", .{ try e.join(parts.items), result });
    try e.flushParts(&parts, expr.span);
    return result;
}

pub fn emitStringLiteral(e: *Emitter, value: []const u8) Error![]const u8 {
    const bytes = try literals.wtf8Bytes(e.arena, value);
    return e.fmt("jsrt_string_from_utf8(\"{s}\", {d})", .{ try literals.escapeBytes(e.arena, bytes), bytes.len });
}

pub fn emitLogicalOp(e: *Emitter, expr: *const nodes.LogicalOp) Error![]const u8 {
    const temp = try requireTempSlot(e, expr, "short-circuit operator");
    const left = try e.emitExpression(expr.left);
    e.indent += 1;
    const captured = try e.captureExpression(expr.right);
    e.indent -= 1;
    if (captured.lines.len == 0) {
        const right = captured.value;
        const test_text = if (expr.operator == .@"??")
            try e.fmt("jsrt_is_nullish({s})", .{temp})
        else
            try e.fmt("jsrt_truthy({s})", .{temp});
        const when_true = if (expr.operator == .@"||") temp else right;
        const when_false = if (expr.operator == .@"||") right else temp;
        return e.fmt("({s} = {s}, {s} ? ({s}) : ({s}))", .{ temp, left, test_text, when_true, when_false });
    }
    try e.line(expr.span, "{s} = {s};", .{ temp, left });
    const enter = switch (expr.operator) {
        .@"&&" => try e.fmt("jsrt_truthy({s})", .{temp}),
        .@"||" => try e.fmt("!jsrt_truthy({s})", .{temp}),
        .@"??" => try e.fmt("jsrt_is_nullish({s})", .{temp}),
    };
    try emitBranchArm(e, expr.span, temp, try e.fmt("if ({s}) {{", .{enter}), captured, "}");
    return temp;
}

pub fn emitConditional(e: *Emitter, expr: *const nodes.ConditionalExpr) Error![]const u8 {
    const temp = try requireTempSlot(e, expr, "conditional");
    const cond = try e.emitExpression(expr.condition);
    e.indent += 1;
    const then_arm = try e.captureExpression(expr.consequent);
    const else_arm = try e.captureExpression(expr.alternate);
    e.indent -= 1;
    if (then_arm.lines.len == 0 and else_arm.lines.len == 0) {
        try e.line(expr.span, "{s} = jsrt_truthy({s}) ? ({s}) : ({s});", .{ temp, cond, then_arm.value, else_arm.value });
        return temp;
    }
    try emitBranchArm(e, expr.span, temp, try e.fmt("if (jsrt_truthy({s})) {{", .{cond}), then_arm, "} else {");
    try emitBranchArm(e, expr.span, temp, null, else_arm, "}");
    return temp;
}

pub fn emitOptionalChain(e: *Emitter, expr: *const nodes.OptionalChain) Error![]const u8 {
    const temp = try requireTempSlot(e, expr, "optional chain");
    const base = try e.emitExpression(expr.base);
    try e.optional_base_stack.append(e.arena, temp);
    const consequent = e.captureExpression(expr.consequent);
    _ = e.optional_base_stack.pop();
    const arm = try consequent;
    if (arm.lines.len == 0) {
        return e.fmt("({s} = {s}, jsrt_is_nullish({s}) ? JSRT_UNDEFINED : ({s}))", .{ temp, base, temp, arm.value });
    }
    try e.line(expr.span, "{s} = {s};", .{ temp, base });
    try emitBranchArm(e, expr.span, temp, try e.fmt("if (jsrt_is_nullish({s})) {{", .{temp}), .{ .lines = &.{}, .value = "JSRT_UNDEFINED" }, "} else {");
    try emitBranchArm(e, expr.span, temp, null, arm, "}");
    return temp;
}

pub fn emitOptionalBase(e: *Emitter) Error![]const u8 {
    const stack = e.optional_base_stack.items;
    if (stack.len == 0) return e.fail("optional-base outside an optional chain; the lowering builds one only", .{});
    return stack[stack.len - 1];
}

/// The place an update reads and writes, with its operands already in slots.
const UpdateAccess = union(enum) {
    slot: []const u8,
    index: struct { target_type: *const HType, target: []const u8, index: []const u8 },
    field: struct { target: []const u8, slot: i32 },
    dyn: struct { target: []const u8, name: []const u8, ic: []const u8 },
    accessor: struct { receiver: []const u8, arg: []const u8, get_callee: ?[]const u8, set_callee: ?[]const u8 },

    fn read(self: UpdateAccess, e: *Emitter) Error![]const u8 {
        return switch (self) {
            .slot => |ref| ref,
            .index => |w| helpers.indexGetCall(e.arena, w.target_type, w.target, w.index),
            .field => |w| e.fmt("jsrt_object_get({s}, {d})", .{ w.target, w.slot }),
            .dyn => |w| e.fmt("jsrt_get_prop({s}, {s}, &{s})", .{ w.target, w.name, w.ic }),
            .accessor => |w| if (w.get_callee) |callee| e.fmt("jsrt_call({s}, 1, &{s})", .{ callee, w.receiver }) else "JSRT_UNDEFINED",
        };
    }

    fn write(self: UpdateAccess, e: *Emitter, value: []const u8) Error![]const u8 {
        return switch (self) {
            .slot => |ref| e.fmt("{s} = {s}", .{ ref, value }),
            .index => |w| helpers.indexSetCall(e.arena, w.target_type, w.target, w.index, value),
            .field => |w| e.fmt("jsrt_object_set({s}, {d}, {s})", .{ w.target, w.slot, value }),
            .dyn => |w| e.fmt("jsrt_set_prop({s}, {s}, {s}, &{s})", .{ w.target, w.name, value, w.ic }),
            .accessor => |w| if (w.set_callee) |callee|
                e.fmt("({s} = {s}, jsrt_call({s}, 2, &{s}))", .{ w.arg, value, callee, w.receiver })
            else
                e.fmt("({s} = {s})", .{ w.arg, value }),
        };
    }
};

/// The place's target goes into the update's first index slot, evaluated once for both the read
/// and the write. Returns that slot's index.
fn storeUpdateTarget(e: *Emitter, expr: *const nodes.UpdateExpr, target: Expression, comptime place: []const u8) Error!usize {
    const base = try e.slotOf(&e.index_slots, expr, "update " ++ place ++ " place was not registered during counting");
    try e.line(expr.span, "{s} = {s};", .{ try e.slotAt(base), try e.emitExpression(target) });
    return base;
}

fn updateTargetSlot(e: *Emitter, expr: *const nodes.UpdateExpr, target: Expression, comptime place: []const u8) Error![]const u8 {
    return e.slotAt(try storeUpdateTarget(e, expr, target, place));
}

fn accessorHalf(e: *Emitter, place: *const nodes.AccessorPlace, receiver: []const u8, slot: anytype, half: []const u8) Error![]const u8 {
    if (place.dispatch == .virtual) return e.fmt("jsrt_method({s}, {d})", .{ receiver, slot });
    return accessorCallee(e, place, half);
}

fn updateAccess(e: *Emitter, expr: *const nodes.UpdateExpr) Error!UpdateAccess {
    switch (expr.target) {
        .identifier => |place| return .{ .slot = try e.slotRef(place.name) },
        .index_access => |place| {
            const base = try storeUpdateTarget(e, expr, place.target, "index");
            const index = try e.slotAt(base + 1);
            try e.line(expr.span, "{s} = {s};", .{ index, try e.emitExpression(place.index) });
            return .{ .index = .{ .target_type = place.target.getType(), .target = try e.slotAt(base), .index = index } };
        },
        .field_access => |place| return .{ .field = .{ .target = try updateTargetSlot(e, expr, place.target, "field"), .slot = place.slot } },
        .dyn_field_access => |place| {
            const target = try updateTargetSlot(e, expr, place.target, "dynamic field");
            return .{ .dyn = .{ .target = target, .name = try literals.cNameLiteral(e.arena, place.field), .ic = try e.icSite() } };
        },
        .accessor_place => |place| {
            const base = try storeUpdateTarget(e, expr, place.target, "accessor");
            const receiver = try e.slotAt(base);
            return .{ .accessor = .{
                .receiver = receiver,
                .arg = try e.slotAt(base + 1),
                .get_callee = if (place.has_get and place.get_slot >= 0) try accessorHalf(e, place, receiver, place.get_slot, "get") else null,
                .set_callee = if (place.set_slot >= 0) try accessorHalf(e, place, receiver, place.set_slot, "set") else null,
            } };
        },
    }
}

pub fn emitUpdate(e: *Emitter, expr: *const nodes.UpdateExpr) Error![]const u8 {
    const slot = try e.slotOf(&e.temp_slots, expr, "update has no frame slot; countExpression missed a node");
    const result = try e.slotAt(slot);
    const span = expr.span;
    const access = try updateAccess(e, expr);
    const place_type = expr.target.expression().getType();
    const op = expr.operator;
    if (op == .@"=") {
        const value = expr.value orelse return e.fail("assignment update is missing its right-hand side", .{});
        const rhs = try e.emitExpression(value);
        try e.line(span, "{s} = {s};", .{ result, rhs });
        try e.line(span, "{s};", .{try access.write(e, result)});
    } else {
        try e.line(span, "{s} = {s};", .{ result, try access.read(e) });
        if (expr.target == .dyn_field_access or expr.target == .index_access or expr.target == .accessor_place) {
            try e.emitPendingCheck(span);
        }
        if (op == .@"++" or op == .@"--") {
            if (place_type.* != .number) {
                try e.line(span, "{s} = jsrt_number(jsrt_to_number({s}));", .{ result, result });
                if (hTypeConversionRunsUserCode(place_type)) try e.emitPendingCheck(span);
            }
            const next = try e.fmt("jsrt_number(jsrt_to_number({s}) {s} 1.0)", .{ result, if (op == .@"++") "+" else "-" });
            if (expr.prefix) {
                try e.line(span, "{s} = {s};", .{ result, next });
                try e.line(span, "{s};", .{try access.write(e, result)});
            } else {
                try e.line(span, "{s};", .{try access.write(e, next)});
            }
        } else if (op == .@"&&" or op == .@"||" or op == .@"??") {
            const value = expr.value orelse return e.fail("logical update is missing its right-hand side", .{});
            const take_right = switch (op) {
                .@"||" => try e.fmt("!jsrt_truthy({s})", .{result}),
                .@"&&" => try e.fmt("jsrt_truthy({s})", .{result}),
                else => try e.fmt("jsrt_is_nullish({s})", .{result}),
            };
            try e.line(span, "if ({s}) {{", .{take_right});
            e.indent += 1;
            const rhs = try e.emitExpression(value);
            try e.line(span, "{s} = {s};", .{ result, rhs });
            try e.line(span, "{s};", .{try access.write(e, result)});
            try e.closeBlock(span);
        } else {
            const value = expr.value orelse return e.fail("compound update is missing its right-hand side", .{});
            var rhs = try e.emitExpression(value);
            if (helpers.compoundConverts(expr)) {
                const right = try e.slotAt(slot + 1);
                try e.line(span, "{s} = {s};", .{ right, rhs });
                try e.emitToNumber(result, place_type, span);
                try e.emitToNumber(right, value.getType(), span);
                rhs = right;
            }
            const binary = helpers.updateAsBinary(op) orelse
                return e.fail("update operator {s} has no binary form", .{@tagName(op)});
            try e.line(span, "{s} = {s};", .{ result, try tables.binaryEmitter(e.arena, binary, result, rhs) });
            if (op == .@"+" and expr.type.* != .number) try e.emitPendingCheck(span);
            try e.line(span, "{s};", .{try access.write(e, result)});
        }
    }
    if (expr.target != .identifier) try e.emitPendingCheck(span);
    return result;
}
