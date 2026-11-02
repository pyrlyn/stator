//! One C function per HIR function, or two for a suspending one. Mirrors
//! `packages/compiler/src/codegen/closures.ts`, which keeps the reasoning for the frame shapes.

const std = @import("std");
const nodes = @import("../hir/nodes.zig");
const emitter = @import("emitter.zig");
const helpers = @import("helpers.zig");
const literals = @import("literals.zig");

const Emitter = emitter.Emitter;
const Error = emitter.Error;
const FunctionUnit = emitter.FunctionUnit;
const FunctionExpr = nodes.FunctionExpr;
const Span = nodes.Span;
const Statement = nodes.Statement;

/// The emission state local to one unit, stashed so the module level resumes intact. Everything not
/// named here, such as classes and inline-cache sites, accumulates across units on purpose.
const UnitState = struct {
    lines: @FieldType(Emitter, "lines"),
    indent: @FieldType(Emitter, "indent"),
    slot_map: @FieldType(Emitter, "slot_map"),
    slot_count: @FieldType(Emitter, "slot_count"),
    in_function: @FieldType(Emitter, "in_function"),
    enclosing: @FieldType(Emitter, "enclosing"),
    used_labels: @FieldType(Emitter, "used_labels"),
    return_slot: @FieldType(Emitter, "return_slot"),
    returns_value: @FieldType(Emitter, "returns_value"),
    env_map: @FieldType(Emitter, "env_map"),
    capture_map: @FieldType(Emitter, "capture_map"),
    pad_stack: @FieldType(Emitter, "pad_stack"),
    unwind_used: @FieldType(Emitter, "unwind_used"),
    try_finally_stack: @FieldType(Emitter, "try_finally_stack"),
    try_count: @FieldType(Emitter, "try_count"),
    in_async: @FieldType(Emitter, "in_async"),
    in_generator: @FieldType(Emitter, "in_generator"),
    await_states: @FieldType(Emitter, "await_states"),
};

fn snapshotUnitState(e: *const Emitter) UnitState {
    var saved: UnitState = undefined;
    inline for (@typeInfo(UnitState).@"struct".field_names) |name| @field(saved, name) = @field(e, name);
    return saved;
}

fn restoreUnitState(e: *Emitter, saved: UnitState) void {
    inline for (@typeInfo(UnitState).@"struct".field_names) |name| @field(e, name) = @field(saved, name);
}

/// `functions` grows while walked: a nested function is only discovered when its parent's body is
/// counted, so this indexes rather than iterates.
pub fn emitFunctionUnits(e: *Emitter) Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i < e.functions.items.len) : (i += 1) {
        try out.appendSlice(e.arena, try e.emitFunctionUnit(e.functions.items[i]));
    }
    return out.items;
}

pub fn emitFunctionUnit(e: *Emitter, unit: FunctionUnit) Error![]const []const u8 {
    const saved = snapshotUnitState(e);

    e.lines = .empty;
    e.indent = 0;
    e.slot_map = try e.newSlotMap();
    e.in_function = true;
    e.enclosing = .empty;
    e.used_labels = .empty;
    e.pad_stack = .empty;
    e.unwind_used = false;
    e.try_finally_stack = .empty;
    e.try_count = 0;

    const function = unit.@"fn";
    e.env_map = .empty;
    for (function.env_vars, 0..) |name, index| try e.env_map.put(e.arena, name, index);
    e.capture_map = .empty;
    for (function.captures) |capture| try e.capture_map.put(e.arena, capture.name, capture);
    e.in_async = function.is_async;
    e.in_generator = function.is_generator;
    e.await_states = .empty;
    if (function.is_async and function.is_generator) {
        return e.fail("async generators are not in this landing", .{});
    }
    // A suspending unit's locals share the array its captured bindings already index from zero.
    e.slot_count = if (function.is_async or function.is_generator) function.env_vars.len else 0;

    for (function.params) |param| try e.bindSlot(param.name);
    if (function.self_binding) |binding| try e.bindSlot(binding);
    for (function.params) |param| {
        if (param.default) |default| try e.countExpression(default);
    }
    // Claimed after counting, and only if something returns a value: a function that never
    // produces one would otherwise root a slot nothing writes.
    e.returns_value = false;
    try e.countBindings(function.body.statements);
    if (function.is_async or function.is_generator) e.returns_value = true;
    if (e.returns_value) {
        e.return_slot = e.slot_count;
        e.slot_count += 1;
    }

    if (function.is_async) {
        try e.emitAsyncUnit(unit);
    } else if (function.is_generator) {
        try e.emitGeneratorUnit(unit);
    } else {
        try e.emitSyncUnit(unit);
    }

    const produced = e.lines.items;
    restoreUnitState(e, saved);
    return produced;
}

/// Every place a list of statements is a scope: hoist its function declarations, then run it.
pub fn emitScope(e: *Emitter, statements: []const Statement) Error!void {
    try e.emitHoistedFunctions(statements);
    for (statements) |stmt| try e.emitStatement(stmt);
}

pub fn emitNamedFunctionSelfBinding(e: *Emitter, function: *const FunctionExpr) Error!void {
    const binding = function.self_binding orelse return;
    const slot = try e.slotRef(binding);
    try e.line(function.span, "{s} = {s};", .{ slot, try e.closureValue(function) });
}

pub fn emitHoistedFunctions(e: *Emitter, statements: []const Statement) Error!void {
    for (statements) |stmt| {
        if (stmt != .function_declaration) continue;
        const declaration = stmt.function_declaration;
        const slot = try e.slotRef(declaration.name);
        try e.line(declaration.span, "{s} = {s};", .{ slot, try e.closureValue(declaration.@"fn") });
    }
}

pub fn registerFunction(e: *Emitter, function: *const FunctionExpr, name: []const u8) Error!usize {
    if (e.function_ids.get(function)) |existing| return existing;
    const id = e.functions.items.len;
    try e.function_ids.put(e.arena, function, id);
    try e.functions.append(e.arena, .{ .id = id, .@"fn" = function, .name = name });
    return id;
}

pub fn functionId(e: *Emitter, function: *const FunctionExpr) Error!usize {
    return e.function_ids.get(function) orelse e.fail("function was not registered during counting", .{});
}

fn emitEntryHeader(e: *Emitter, unit: FunctionUnit) Error!void {
    try e.openBlock(try e.fmt("static jsrt_value _jsrt_fn_{d}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {{", .{unit.id}), null);
    // Before the frame, so the overflow return has nothing to pop.
    try e.appendLine("JSRT_STACK_CHECK();", unit.@"fn".span);
}

pub fn emitSyncUnit(e: *Emitter, unit: FunctionUnit) Error!void {
    const function = unit.@"fn";
    const span = function.span;
    try emitEntryHeader(e, unit);
    // A zero-length array is not valid C11, and a function that roots nothing is valid TypeScript.
    try e.line(span, "JSRT_FRAME({d});", .{@max(1, e.slot_count)});
    if (function.env_vars.len > 0) {
        try e.line(span, "JSRTEnv *_jsrt_env = jsrt_env_new(env, {d});", .{function.env_vars.len});
        try e.appendLine("JSRT_FRAME_ENV(_jsrt_env);", span);
    } else if (function.captures.len == 0) {
        // The ABI passes an environment regardless, so silence it for -Werror.
        try e.appendLine("(void)env;", span);
    }
    try e.emitParameterPrologue(function);
    try e.emitNamedFunctionSelfBinding(function);
    try e.emitHoistedFunctions(function.body.statements);
    for (function.body.statements) |stmt| try e.emitStatement(stmt);
    // Falling off the end of a JavaScript function returns `undefined`, and still has to pop.
    try e.appendLine("JSRT_FRAME_POP();", span);
    try e.appendLine("return JSRT_UNDEFINED;", span);
    if (e.unwind_used) {
        // The frame pops on every exit; the exception stays pending for the caller's own check.
        try e.appendLine("_jsrt_unwind: ;", span);
        try e.appendLine("JSRT_FRAME_POP();", span);
        try e.appendLine("return JSRT_UNDEFINED;", span);
    }
    try e.closeDefinition();
}

/// The entry that starts the state machine, then the resume function up to its settle, which only
/// the caller knows.
fn openResumeUnit(e: *Emitter, unit: FunctionUnit, kind: []const u8, params: []const u8, start: []const u8, unused_when_empty: []const []const u8) Error!void {
    const resume_name = try e.fmt("_jsrt_{s}_{d}", .{ kind, unit.id });
    try e.line(null, "static void {s}({s});", .{ resume_name, params });
    try e.appendLine("", null);
    try e.emitSuspendEntry(unit, try e.fmt("{s}(_jsrt_env, {s})", .{ start, resume_name }));
    try e.openBlock(try e.fmt("static void {s}({s}) {{", .{ resume_name, params }), null);
    try e.emitResumeOpen(unit.@"fn".span, unused_when_empty);
    try e.emitResumeBody(unit.@"fn");
}

pub fn emitAsyncUnit(e: *Emitter, unit: FunctionUnit) Error!void {
    const span = unit.@"fn".span;
    e.used_async = true;
    try openResumeUnit(e, unit, "async", "JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err", "jsrt_async_start", &.{ "_jsrt_v", "_jsrt_err" });
    try e.emitAsyncSettle("jsrt_async_return", "JSRT_UNDEFINED", span);
    if (e.unwind_used) {
        // An exception reaching the top of an async body rejects rather than staying pending.
        const slot = try e.slotAt(e.return_slot);
        try e.appendLine("_jsrt_unwind: ;", span);
        try e.line(span, "{s} = jsrt_take_exception();", .{slot});
        try e.emitAsyncSettle("jsrt_async_throw", slot, span);
    }
    try e.closeDefinition();
}

pub fn emitGeneratorUnit(e: *Emitter, unit: FunctionUnit) Error!void {
    const span = unit.@"fn".span;
    try openResumeUnit(e, unit, "gen", "JSRTGenerator *_jsrt_self, jsrt_value _jsrt_v", "jsrt_generator_new", &.{"_jsrt_v"});
    try e.emitGeneratorSettle("JSRT_UNDEFINED", span);
    if (e.unwind_used) {
        // Marked done so a later `next()` after the throw answers rather than re-entering.
        try e.appendLine("_jsrt_unwind: ;", span);
        try e.appendLine("_jsrt_self->done = true;", span);
        try e.appendLine("JSRT_FRAME_POP();", span);
        try e.appendLine("return;", span);
    }
    try e.closeDefinition();
}

pub fn emitSuspendEntry(e: *Emitter, unit: FunctionUnit, produce: []const u8) Error!void {
    const function = unit.@"fn";
    const span = function.span;
    try emitEntryHeader(e, unit);
    try e.appendLine("JSRT_FRAME(1);", span);
    try e.line(span, "JSRTEnv *_jsrt_env = jsrt_env_new(env, {d});", .{@max(1, e.slot_count)});
    try e.appendLine("JSRT_FRAME_ENV(_jsrt_env);", span);
    try e.emitParameterPrologue(function);
    try e.line(span, "jsrt_value _jsrt_r = {s};", .{produce});
    if (e.threaded()) try e.appendLine("jsrt_gc_handoff(_jsrt_r);", span);
    try e.appendLine("JSRT_FRAME_POP();", span);
    try e.appendLine("return _jsrt_r;", span);
    try e.closeDefinition();
}

pub fn emitResumeOpen(e: *Emitter, span: Span, unused_when_empty: []const []const u8) Error!void {
    try e.appendLine("JSRT_FRAME(1);", span);
    try e.appendLine("JSRTEnv *_jsrt_env = _jsrt_self->env;", span);
    try e.appendLine("JSRT_FRAME_ENV(_jsrt_env);", span);
    try e.appendLine("JSRTEnv *env = _jsrt_env->parent;", span);
    try e.appendLine("(void)env;", span);
    if (e.await_states.count() > 0) {
        try e.openBlock("switch (_jsrt_self->state) {", span);
        for (e.await_states.values()) |state| {
            try e.line(span, "case {d}: goto _jsrt_res_{d};", .{ state, state });
        }
        try e.appendLine("default: break;", null);
        try e.closeBlock(span);
        return;
    }
    for (unused_when_empty) |name| try e.line(span, "(void){s};", .{name});
}

pub fn emitResumeBody(e: *Emitter, function: *const FunctionExpr) Error!void {
    try e.emitNamedFunctionSelfBinding(function);
    try e.emitHoistedFunctions(function.body.statements);
    for (function.body.statements) |stmt| try e.emitStatement(stmt);
}

pub fn suspendSlot(e: *Emitter, expr: nodes.Expression) Error![]const u8 {
    const slot = e.temp_slots.get(expr.id()) orelse
        return e.fail("{s} was not registered during counting", .{@tagName(expr)});
    return e.slotAt(slot);
}

pub fn emitPark(e: *Emitter, expr: nodes.Expression, value: nodes.Expression, park_call: []const u8) Error![]const u8 {
    const state = e.await_states.get(expr.id()) orelse
        return e.fail("{s} was not registered during counting", .{@tagName(expr)});
    const span = expr.getSpan();
    const at = try e.suspendSlot(expr);
    try e.line(span, "{s} = {s};", .{ at, try e.emitExpression(value) });
    try e.line(span, "_jsrt_self->state = {d};", .{state});
    // The resume prologue re-reads this, so the CURRENT environment has to be parked before the
    // frame disappears: a resume inside a per-iteration loop must come back on the iteration's
    // clone, not on the loop's base environment.
    try e.appendLine("_jsrt_self->env = _jsrt_env;", span);
    try e.appendLine(park_call, span);
    try e.appendLine("JSRT_FRAME_POP();", span);
    try e.appendLine("return;", span);
    try e.line(span, "_jsrt_res_{d}: ;", .{state});
    return at;
}

/// Settle then pop: settling allocates a microtask while the value must still be rooted.
pub fn emitAsyncSettle(e: *Emitter, function: []const u8, value: []const u8, span: Span) Error!void {
    try e.line(span, "{s}(_jsrt_self, {s});", .{ function, value });
    try e.appendLine("JSRT_FRAME_POP();", span);
    try e.appendLine("return;", span);
}

pub fn emitGeneratorSettle(e: *Emitter, value: []const u8, span: Span) Error!void {
    return e.emitAsyncSettle("jsrt_generator_return", value, span);
}

pub fn emitParameterPrologue(e: *Emitter, function: *const FunctionExpr) Error!void {
    if (function.params.len == 0) {
        try e.appendLine("(void)argc;", null);
        try e.appendLine("(void)argv;", null);
    }
    for (function.params, 0..) |param, index| {
        const slot = try e.slotRef(param.name);
        const reader = if (param.rest == true) "jsrt_args_rest" else "jsrt_arg";
        try e.line(param.span, "{s} = {s}(argc, argv, {d});", .{ slot, reader, index });
        if (param.default) |default| {
            try e.line(param.span, "if (jsrt_is({s}, JSRT_TAG_UNDEFINED)) {{", .{slot});
            e.indent += 1;
            const value = try e.emitExpression(default);
            try e.line(param.span, "{s} = {s};", .{ slot, value });
            try e.closeBlock(param.span);
        }
    }
}

pub fn currentEnv(e: *const Emitter) []const u8 {
    if (e.env_map.count() > 0) return "_jsrt_env";
    return if (e.in_function) "env" else "NULL";
}

/// A function that captures nothing stays a file-static constant with no allocation; one that does
/// is built per evaluation, so two evaluations close over different variables.
pub fn closureValue(e: *Emitter, function: *const FunctionExpr) Error![]const u8 {
    const id = try e.functionId(function);
    if (!function.needs_env) return e.fmt("jsrt_closure(&_jsrt_closure_{d})", .{id});
    const name = try literals.cNameLiteral(e.arena, function.name orelse "");
    const meta = helpers.closureMeta(function);
    const closure = try e.fmt("jsrt_closure_new(_jsrt_fn_{d}, {d}, {s}, {s}, {s})", .{
        id,
        meta.arity,
        name,
        e.currentEnv(),
        if (meta.has_receiver) "true" else "false",
    });
    return if (function.constructible == true) e.fmt("jsrt_closure_constructible({s})", .{closure}) else closure;
}
