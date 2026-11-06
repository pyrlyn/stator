//! Sequencing of operands and the calls into the runtime. Mirrors
//! `packages/compiler/src/codegen/runtime_calls.ts`, which keeps the reasoning.

const std = @import("std");
const nodes = @import("../hir/nodes.zig");
const emitter = @import("emitter.zig");
const literals = @import("literals.zig");

const Emitter = emitter.Emitter;
const Error = emitter.Error;
const Captured = emitter.Captured;
const Parts = emitter.Parts;
const Expression = nodes.Expression;
const Span = nodes.Span;

pub fn emitPendingCheck(e: *Emitter, span: Span) Error!void {
    try e.line(span, "if (jsrt_pending()) {{ goto {s}; }}", .{try e.currentPad()});
}

/// Evaluates into a buffer of its own: the caller decides from the buffer whether the value needs
/// statements ahead of it. Entries stay as appended, so the caller splices them without re-indenting.
pub fn captureExpression(e: *Emitter, expr: Expression) Error!Captured {
    const saved = e.lines;
    e.lines = .empty;
    const value = try e.emitExpression(expr);
    const buffer = e.lines.items;
    e.lines = saved;
    return .{ .lines = buffer, .value = value };
}

/// The callback `use(value)` of the TS is always a text wrap around the value, so a prefix and a
/// suffix say the same thing without a closure.
pub const Use = struct {
    prefix: []const u8,
    suffix: []const u8 = "",

    fn apply(self: Use, e: *Emitter, value: []const u8) Error![]const u8 {
        return e.fmt("{s}{s}{s}", .{ self.prefix, value, self.suffix });
    }
};

/// True when the operand needed statements, which flushes whatever was pending ahead of them.
pub fn sequencePart(e: *Emitter, parts: *Parts, operand: Expression, span: Span, use: Use) Error!bool {
    const captured = try e.captureExpression(operand);
    if (captured.lines.len == 0) {
        try parts.append(e.arena, try use.apply(e, captured.value));
        return false;
    }
    try e.flushParts(parts, span);
    try e.pushLines(captured.lines);
    try e.line(span, "{s};", .{try use.apply(e, captured.value)});
    return true;
}

pub fn sequenceAssign(e: *Emitter, parts: *Parts, operand: Expression, span: Span, slot: usize) Error!bool {
    return e.sequencePart(parts, operand, span, .{ .prefix = try e.fmt("{s} = ", .{try e.slotAt(slot)}) });
}

pub fn flushParts(e: *Emitter, parts: *Parts, span: Span) Error!void {
    if (parts.items.len == 0) return;
    try e.line(span, "{s};", .{try e.join(parts.items)});
    parts.clearRetainingCapacity();
}

pub fn slotList(e: *Emitter, base: usize, count: usize) Error![]const u8 {
    var items: std.ArrayList([]const u8) = .empty;
    for (0..count) |index| try items.append(e.arena, try e.slotAt(base + index));
    return e.join(items.items);
}

pub fn arrayOpCall(e: *Emitter, expr: *const nodes.ArrayOp, base: usize) Error![]const u8 {
    const target = try e.slotAt(base);
    const count = expr.args.len;
    const arg0 = if (count > 0) try e.slotAt(base + 1) else "";
    const arg1 = if (count > 1) try e.slotAt(base + 2) else "";
    switch (expr.op) {
        .push, .unshift => {
            const op = @tagName(expr.op);
            if (count == 1) return e.fmt("jsrt_array_{s}({s}, {s})", .{ op, target, arg0 });
            if (count == 0) return e.fmt("jsrt_array_{s}_many({s}, 0)", .{ op, target });
            return e.fmt("jsrt_array_{s}_many({s}, {d}, {s})", .{ op, target, count, try slotList(e, base + 1, count) });
        },
        .splice => {
            if (count == 0) return e.fmt("jsrt_array_splice({s}, JSRT_UNDEFINED, JSRT_UNDEFINED)", .{target});
            if (count == 1) return e.fmt("jsrt_array_splice_from({s}, {s})", .{ target, arg0 });
            if (count == 2) return e.fmt("jsrt_array_splice({s}, {s}, {s})", .{ target, arg0, arg1 });
            return e.fmt("jsrt_array_splice_insert({s}, {s}, {s}, {d}, {s})", .{ target, arg0, arg1, count - 2, try slotList(e, base + 3, count - 2) });
        },
        .concat => {
            const call = if (count == 1 and expr.args[0].getType().* == .array)
                try e.fmt("jsrt_array_concat({s}, {s})", .{ target, arg0 })
            else if (count == 0)
                try e.fmt("jsrt_array_concat_many({s}, 0)", .{target})
            else
                try e.fmt("jsrt_array_concat_many({s}, {d}, {s})", .{ target, count, try slotList(e, base + 1, count) });
            return if (expr.spread == true) e.fmt("jsrt_array_fill_holes({s})", .{call}) else call;
        },
        .lastIndexOf => if (count == 2) {
            return e.fmt("jsrt_array_last_index_of_from({s}, {s}, {s})", .{ target, arg0, arg1 });
        },
        else => {},
    }
    const name = try literals.snakeCase(e.arena, @tagName(expr.op));
    return e.fmt("jsrt_array_{s}({s})", .{ name, try slotList(e, base, count + 1) });
}

pub fn sequenceArgs(e: *Emitter, parts: *Parts, args: []const Expression, span: Span, base: usize, start: usize) Error!bool {
    var flushed = false;
    for (args, 0..) |arg, index| {
        flushed = (try e.sequenceAssign(parts, arg, span, base + start + index)) or flushed;
    }
    return flushed;
}

/// With nothing flushed, a comma expression keeps the whole call in value position.
pub fn finishSequenced(e: *Emitter, parts: *Parts, result: []const u8, span: Span, flushed: bool) Error![]const u8 {
    if (!flushed) {
        try parts.append(e.arena, result);
        return e.fmt("({s})", .{try e.join(parts.items)});
    }
    try e.flushParts(parts, span);
    return result;
}

pub fn beginCall(e: *Emitter, parts: *Parts, first: Expression, args: []const Expression, span: Span, base: usize) Error!void {
    _ = try e.sequenceAssign(parts, first, span, base);
    _ = try e.sequenceArgs(parts, args, span, base, 1);
}

pub fn finishOp(e: *Emitter, parts: *Parts, base: usize, op_call: []const u8, span: Span, flushed: bool, can_throw: bool) Error![]const u8 {
    if (!can_throw) return e.finishSequenced(parts, op_call, span, flushed);
    const slot = try e.slotAt(base);
    return e.finishStatement(parts, try e.fmt("{s} = {s}", .{ slot, op_call }), slot, span);
}

pub fn finishStatement(e: *Emitter, parts: *Parts, assignment: []const u8, result: []const u8, span: Span) Error![]const u8 {
    try parts.append(e.arena, assignment);
    try e.flushParts(parts, span);
    try e.emitPendingCheck(span);
    return result;
}

const OutWrite = struct { name: []const u8, slot: []const u8 };

pub fn emitExternCall(e: *Emitter, expr: *const nodes.ExternCall, base: usize) Error![]const u8 {
    const site = e.extern_site_count;
    e.extern_site_count += 1;
    // A main-queue post runs only inside the drain `main` emits after the module body; without
    // it a program whose one event source is a post (`node:timers`) exits before the post runs.
    if (std.mem.eql(u8, expr.c_name, "jsrt_thread_run_on_main")) e.used_async = true;
    const span = expr.span;
    const arg_start: usize = if (expr.ret_kind == .void) 0 else 1;
    var parts: Parts = .empty;
    _ = try e.sequenceArgs(&parts, expr.args, span, base, arg_start);
    try e.flushParts(&parts, span);
    var c_args: Parts = .empty;
    var out_writes: std.ArrayList(OutWrite) = .empty;
    for (expr.args, 0..) |arg, index| {
        const slot = try e.slotAt(base + arg_start + index);
        if (index >= expr.arg_kinds.len) return e.fail("extern call argument has no C passing: missing", .{});
        switch (expr.arg_kinds[index]) {
            .cstring, .@"cstring-owned" => {
                const temp = try e.fmt("_jsrt_exc_{d}_{d}", .{ site, index });
                try e.line(span, "char *{s} = jsrt_string_to_cstr({s});", .{ temp, slot });
                try c_args.append(e.arena, temp);
            },
            .value => try c_args.append(e.arena, slot),
            .number => try c_args.append(e.arena, try e.fmt("jsrt_to_number({s})", .{slot})),
            .boolean => try c_args.append(e.arena, try e.fmt("jsrt_as_bool({s})", .{slot})),
            .pointer => try c_args.append(e.arena, try e.fmt("jsrt_ptr({s})", .{slot})),
            .bytes => {
                if (arg != .boundary_check) {
                    try e.line(span, "(void)jsrt_check_uint8array({s}, {s});", .{ slot, try e.callLocation(span) });
                }
                try c_args.append(e.arena, try e.fmt("(void *)jsrt_uint8array_bytes({s})", .{slot}));
                try c_args.append(e.arena, try e.fmt("jsrt_uint8array_count({s})", .{slot}));
            },
            .@"out-pointer" => {
                const tag = (if (index < expr.arg_tags.len) expr.arg_tags[index] else null) orelse
                    return e.fail("extern call out-pointer argument {d} has no cast tag", .{index});
                const cast = if (expr.header == null)
                    "(void**)"
                else if (std.mem.eql(u8, tag, "char"))
                    "(const char**)"
                else
                    try e.fmt("({s}**)", .{tag});
                try c_args.append(e.arena, try e.fmt("{s}&{s}", .{ cast, slot }));
                if (arg == .identifier) try out_writes.append(e.arena, .{ .name = arg.identifier.name, .slot = slot });
            },
            .void => return e.fail("extern call argument has no C passing: void", .{}),
        }
    }
    if (expr.@"error" == .errno) try e.appendLine("errno = 0;", span);
    const call = try e.fmt("{s}({s})", .{ expr.c_name, try e.join(c_args.items) });
    const raw = try e.fmt("_jsrt_exr_{d}", .{site});
    if (expr.ret_kind == .void) {
        try e.line(span, "{s};", .{call});
    } else if (expr.ret_kind == .cstring) {
        try e.line(span, "char * {s} = (char *)({s});", .{ raw, call });
    } else {
        try e.line(span, "{s} {s} = {s};", .{ externCType(expr.ret_kind), raw, call });
    }
    for (out_writes.items) |write| {
        try e.line(span, "{s} = {s};", .{ try e.slotRef(write.name), write.slot });
    }
    if (expr.@"error" == .errno) try e.line(span, "int _jsrt_exe_{d} = errno;", .{site});
    const result = if (expr.ret_kind == .void) "JSRT_UNDEFINED" else try e.slotAt(base);
    if (expr.ret_kind != .void) {
        const copy_out = if (expr.@"error" == .null or expr.@"error" == .errno)
            try e.fmt("({s} == NULL ? JSRT_UNDEFINED : jsrt_string_from_cstr({s}))", .{ raw, raw })
        else
            try e.fmt("jsrt_string_from_cstr({s})", .{raw});
        const boxed = switch (expr.ret_kind) {
            .value => raw,
            .number => try e.fmt("jsrt_number({s})", .{raw}),
            .boolean => try e.fmt("jsrt_bool({s})", .{raw}),
            .pointer => try e.fmt("(jsrt_value)(uintptr_t){s}", .{raw}),
            else => copy_out,
        };
        try e.line(span, "{s} = {s};", .{ result, boxed });
    }
    for (expr.args, 0..) |_, index| {
        if (expr.arg_kinds[index] == .cstring) try e.line(span, "free(_jsrt_exc_{d}_{d});", .{ site, index });
    }
    if (expr.@"error") |convention| {
        const detail = switch (convention) {
            .nonzero => "nonzero return",
            .negative => "negative return",
            .null => "NULL return",
            .errno => "errno set",
        };
        const failed = switch (convention) {
            .nonzero => try e.fmt("{s} != 0", .{raw}),
            .negative => try e.fmt("{s} < 0", .{raw}),
            .null => try e.fmt("{s} == NULL", .{raw}),
            .errno => try e.fmt("_jsrt_exe_{d} != 0", .{site}),
        };
        try e.line(span, "if ({s}) {{ jsrt_throw_error(&jsrt_class_error, \"extern call '{s}' failed: {s}\"); }}", .{
            failed,
            try literals.escapeCString(e.arena, expr.ts_name),
            detail,
        });
        try e.emitPendingCheck(span);
    }
    return result;
}

pub fn consoleSlots(e: *Emitter, expr: *const nodes.ConsoleLogCall) Error!usize {
    const base = try e.slotOf(&e.call_slots, expr, "console arguments were not registered during counting");
    var parts: Parts = .empty;
    for (expr.args, 0..) |arg, index| _ = try e.sequenceAssign(&parts, arg, expr.span, base + index);
    try e.flushParts(&parts, expr.span);
    return base;
}

pub fn consoleCall(e: *Emitter, expr: *const nodes.ConsoleLogCall) Error![]const u8 {
    const count = expr.args.len;
    const function = nodes.consoleEntryPoint(expr.method, count) orelse
        return e.fail("console.{s} has no entry point for {d} arguments", .{ @tagName(expr.method), count });
    if (nodes.isConsoleVariadicWidth(expr.method, count)) {
        if (count == 0) return e.fmt("{s}(0, NULL)", .{function});
        const base = try e.consoleSlots(expr);
        return e.fmt("{s}({d}, &{s})", .{ function, count, try e.slotAt(base) });
    }
    if (count < 2) {
        var operands: Parts = .empty;
        for (expr.args) |arg| try operands.append(e.arena, try e.emitExpression(arg));
        return e.fmt("{s}({s})", .{ function, try e.join(operands.items) });
    }
    const base = try e.consoleSlots(expr);
    return e.fmt("{s}({s})", .{ function, try slotList(e, base, count) });
}

pub fn icSite(e: *Emitter) Error![]const u8 {
    const name = try e.fmt("_jsrt_ic_{d}", .{e.ic_count});
    e.ic_count += 1;
    return name;
}

pub fn callLocation(e: *Emitter, span: Span) Error![]const u8 {
    const file = try literals.escapeCString(e.arena, span.file orelse e.file_name);
    return e.fmt("\"{s}:{d}\"", .{ file, span.line });
}

pub fn externCType(kind: nodes.ExternAbiKind) []const u8 {
    return switch (kind) {
        .value => "jsrt_value",
        .number => "double",
        .boolean => "bool",
        .cstring, .@"cstring-owned" => "const char *",
        .pointer => "void *",
        .@"out-pointer" => "void **",
        .bytes => "uint8_t *, size_t",
        .void => "void",
    };
}

pub fn externCReturnType(kind: nodes.ExternAbiKind) []const u8 {
    return if (kind == .cstring) "char *" else externCType(kind);
}

/// Deletion keeps the order of the rest, which is the order the prologue prints.
pub fn recordExternDecl(e: *Emitter, expr: *const nodes.ExternCall) Error!void {
    if (expr.@"error" == .errno) e.extern_errno = true;
    if (std.mem.indexOfScalar(nodes.ExternAbiKind, expr.arg_kinds, .cstring) != null) e.extern_stdlib = true;
    if (expr.header) |header| {
        for (e.extern_headers.items) |known| {
            if (std.mem.eql(u8, known, header)) break;
        } else try e.extern_headers.append(e.arena, header);
        try e.extern_header_covered.put(e.arena, expr.c_name, {});
        _ = e.extern_decls.orderedRemove(expr.c_name);
        return;
    }
    if (e.extern_header_covered.contains(expr.c_name) or e.extern_decls.contains(expr.c_name)) return;
    var params: Parts = .empty;
    for (expr.arg_kinds) |kind| try params.append(e.arena, externCType(kind));
    const list = if (expr.arg_kinds.len == 0) "void" else try e.join(params.items);
    try e.extern_decls.put(e.arena, expr.c_name, try e.fmt("{s} {s}({s});", .{ externCReturnType(expr.ret_kind), expr.c_name, list }));
}
