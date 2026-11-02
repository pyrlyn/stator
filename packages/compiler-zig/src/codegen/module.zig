//! The translation unit: frame sizes, the static tables, `main` or a library's init and stubs.
//! Mirrors `packages/compiler/src/codegen/module.ts`.

const std = @import("std");
const nodes = @import("../hir/nodes.zig");
const emitter = @import("emitter.zig");
const helpers = @import("helpers.zig");
const literals = @import("literals.zig");

const Emitter = emitter.Emitter;
const Error = emitter.Error;
const Module = nodes.Module;
const Span = nodes.Span;

pub const ExportedParam = struct { name: []const u8, c_type: []const u8 };

pub const ExportedFunction = struct {
    name: []const u8,
    c_name: []const u8,
    params: []const ExportedParam,
    ret: []const u8,
};

pub const ExportedConst = struct { name: []const u8, c_name: []const u8, c_type: []const u8 };

pub const UnitExports = struct {
    functions: []const ExportedFunction = &.{},
    consts: []const ExportedConst = &.{},
};

/// Present only in library builds; an executable keeps its `main`.
pub const LibraryEmit = struct { unit: []const u8, exports: UnitExports = .{} };

const Out = std.ArrayList([]const u8);

fn push(e: *Emitter, out: *Out, comptime format: []const u8, args: anytype) Error!void {
    try out.append(e.arena, try e.fmt(format, args));
}

pub fn emit(e: *Emitter, module: *const Module, library: ?LibraryEmit) Error![]const u8 {
    e.file_name = module.file_name;
    e.slot_map = try e.newSlotMap();
    e.global_map = try e.newSlotMap();
    e.env_map = .empty;
    for (module.env_vars, 0..) |name, index| try e.env_map.put(e.arena, name, index);
    try e.countBindings(module.statements);
    e.global_map = e.slot_map;
    e.global_count = e.slot_count;
    const export_scratch: usize = if (library == null) 0 else e.global_count;
    const global_slots = @max(e.global_count + @as(usize, if (library == null) 0 else 1), 1);

    const function_lines = try e.emitFunctionUnits();
    const main_lines = if (library) |unit|
        try e.emitLibrary(module, unit, global_slots, export_scratch)
    else
        try e.emitMain(module, global_slots);

    var out: Out = .empty;
    try out.append(e.arena, "#include \"jsrt_value.h\"");
    if (e.extern_errno) try out.append(e.arena, "#include <errno.h>");
    if (e.extern_stdlib or library != null) try out.append(e.arena, "#include <stdlib.h>");
    if (library != null) try out.append(e.arena, "#include <stdbool.h>");
    for (e.extern_headers.items) |header| try push(e, &out, "#include {s}", .{header});
    try out.append(e.arena, "");
    try push(e, &out, "JSRT_GLOBALS({d});", .{global_slots});
    try out.append(e.arena, "");
    for (e.functions.items) |unit| {
        try push(e, &out, "static jsrt_value _jsrt_fn_{d}(uint32_t argc, const jsrt_value *argv, JSRTEnv *env);", .{unit.id});
        const meta = helpers.closureMeta(unit.@"fn");
        try push(e, &out, "static JSRTClosure _jsrt_closure_{d} = {{_jsrt_fn_{d}, {d}, {s}, NULL, {s}, NULL, {s}}};", .{
            unit.id,
            unit.id,
            meta.arity,
            try literals.cNameLiteral(e.arena, unit.name),
            if (meta.has_receiver) "true" else "false",
            if (unit.@"fn".constructible == true) "true" else "false",
        });
    }
    if (e.functions.items.len > 0) try out.append(e.arena, "");
    for (e.classes.items, 0..) |class, id| try pushClass(e, &out, class, id);
    if (e.classes.items.len > 0) try out.append(e.arena, "");
    for (0..e.ic_count) |i| try push(e, &out, "static _Thread_local JSRTIC _jsrt_ic_{d};", .{i});
    if (e.ic_count > 0) try out.append(e.arena, "");
    for (e.extern_decls.values()) |decl| try out.append(e.arena, decl);
    if (e.extern_decls.count() > 0) try out.append(e.arena, "");
    try out.appendSlice(e.arena, function_lines);
    try out.appendSlice(e.arena, main_lines);

    var text: std.ArrayList(u8) = .empty;
    for (out.items, 0..) |line, index| {
        if (index > 0) try text.append(e.arena, '\n');
        try text.appendSlice(e.arena, line);
    }
    try text.append(e.arena, '\n');
    return text.items;
}

fn pushClass(e: *Emitter, out: *Out, class: *const nodes.ClassDeclaration, id: usize) Error!void {
    var names: emitter.Parts = .empty;
    for (class.fields) |field| try names.append(e.arena, try literals.cNameLiteral(e.arena, field.name));
    const field_names = if (class.fields.len == 0) "\"\"" else try e.join(names.items);
    try push(e, out, "static const char *const _jsrt_fields_{d}[] = {{{s}}};", .{ id, field_names });
    if (class.vtable.len > 0) {
        var entries: emitter.Parts = .empty;
        var method_names: emitter.Parts = .empty;
        for (class.vtable) |entry| {
            const method = try e.methodIdOrNull(entry);
            try entries.append(e.arena, if (method) |known| try e.fmt("&_jsrt_closure_{d}", .{known}) else "NULL");
        }
        try push(e, out, "static const JSRTClosure *const _jsrt_methods_{d}[] = {{{s}}};", .{ id, try e.join(entries.items) });
        for (class.vtable) |entry| try method_names.append(e.arena, try literals.cNameLiteral(e.arena, entry.name));
        try push(e, out, "static const char *const _jsrt_method_names_{d}[] = {{{s}}};", .{ id, try e.join(method_names.items) });
    }
    const table = if (class.vtable.len == 0)
        "0, NULL, NULL"
    else
        try e.fmt("{d}, _jsrt_methods_{d}, _jsrt_method_names_{d}", .{ class.vtable.len, id, id });
    const key_order = e.class_key_orders.get(id);
    if (key_order) |order| {
        var keys: emitter.Parts = .empty;
        for (order) |key| try keys.append(e.arena, try e.fmt("{d}", .{key}));
        try push(e, out, "static const uint32_t _jsrt_keys_{d}[] = {{{s}}};", .{ id, try e.join(keys.items) });
    }
    const display = try literals.cNameLiteral(e.arena, literals.descriptorName(class.name));
    try push(e, out, "static const JSRTClass _jsrt_class_{d} = {{{s}, {d}, _jsrt_fields_{d}, {s}, {s}, {s}, NULL}};", .{
        id,
        display,
        class.fields.len,
        id,
        try e.baseDescriptor(class, id),
        table,
        if (key_order == null) "NULL" else try e.fmt("_jsrt_keys_{d}", .{id}),
    });
    const ctor_fn = if (class.ctor) |ctor| try e.fmt("_jsrt_fn_{d}", .{try e.functionId(ctor.@"fn")}) else "NULL";
    const ctor_arity = if (class.ctor) |ctor| helpers.closureMeta(ctor.@"fn").arity else 0;
    try push(e, out, "static const JSRTClosure _jsrt_class_object_{d} = {{{s}, {d}, {s}, NULL, false, &_jsrt_class_{d}}};", .{ id, ctor_fn, ctor_arity, display, id });
}

pub fn emitModuleEnv(e: *Emitter, module: *const Module) Error!void {
    if (module.env_vars.len > 0) {
        try e.line(module.span, "JSRTEnv *_jsrt_env = jsrt_env_new(NULL, {d});", .{module.env_vars.len});
        try e.appendLine("JSRT_GLOBALS_ENV(_jsrt_env);", module.span);
    }
}

pub fn emitSyncTopLevelStatements(e: *Emitter, module: *const Module) Error!void {
    try e.emitHoistedFunctions(module.statements);
    for (module.statements) |stmt| try e.emitStatement(stmt);
}

pub fn emitMicrotaskDrain(e: *Emitter, module: *const Module) Error!void {
    if (e.used_async) try e.appendLine("jsrt_run_microtasks();", module.span);
}

fn beginModuleUnits(e: *Emitter) void {
    e.lines = .empty;
    e.indent = 0;
    e.in_function = false;
    e.slot_map = e.global_map;
    e.slot_count = e.global_count;
    e.pad_stack = .empty;
    e.unwind_used = false;
    e.try_finally_stack = .empty;
    e.try_count = 0;
}

pub fn emitMain(e: *Emitter, module: *const Module, global_slots: usize) Error![]const []const u8 {
    beginModuleUnits(e);
    if (module.is_async) {
        try e.emitAsyncModule(module, global_slots);
        return e.lines.items;
    }
    try e.emitMainEntry(module, global_slots);
    try e.emitModuleEnv(module);
    try e.emitSyncTopLevelStatements(module);
    try e.emitMicrotaskDrain(module);
    try e.appendLine("return (int)jsrt_process_exit_code();", module.span);
    if (e.unwind_used) {
        try e.appendLine("_jsrt_unwind: ;", module.span);
        try e.appendLine("jsrt_uncaught();", module.span);
    }
    try e.closeBlock(null);
    return e.lines.items;
}

pub fn emitMainEntry(e: *Emitter, module: *const Module, global_slots: usize) Error!void {
    try e.openBlock("int main(int argc, char **argv) {", null);
    try e.appendLine("jsrt_init();", module.span);
    try e.appendLine("jsrt_process_args(argc, argv);", module.span);
    try e.line(module.span, "JSRT_GLOBALS_ENTER({d});", .{global_slots});
}

pub fn emitAsyncModule(e: *Emitter, module: *const Module, global_slots: usize) Error!void {
    const env_slots = try e.countAsyncModule(module);
    try e.emitModuleDoneMain();
    try e.emitAsyncModuleForward();
    try e.emitMainEntry(module, global_slots);
    try e.emitAsyncModuleRun(module, env_slots, "_jsrt_module_done");
    try e.appendLine("return (int)jsrt_process_exit_code();", module.span);
    try e.closeDefinition();
    try e.emitAsyncModuleBody(module);
}

pub fn countAsyncModule(e: *Emitter, module: *const Module) Error!usize {
    e.used_async = true;
    e.module_async = true;
    e.in_async = true;
    e.in_function = true;
    e.slot_map = try e.newSlotMap();
    e.env_map = .empty;
    for (module.env_vars, 0..) |name, index| try e.env_map.put(e.arena, name, index);
    e.slot_count = module.env_vars.len;
    e.capture_map = .empty;
    e.await_states = .empty;
    e.returns_value = true;
    try e.countBindings(module.statements);
    e.return_slot = e.slot_count;
    e.slot_count += 1;
    return @max(1, e.slot_count);
}

/// The callback a top-level await's promise settles into; only a rejection does anything.
fn emitDoneCallback(e: *Emitter, name: []const u8, on_rejected: []const []const u8) Error!void {
    try e.openBlock(try e.fmt("static void {s}(void *state, jsrt_value value, bool rejected) {{", .{name}), null);
    try e.appendLine("(void)state;", null);
    try e.openBlock("if (rejected) {", null);
    for (on_rejected) |text| try e.appendLine(text, null);
    try e.closeBlock(null);
    try e.closeDefinition();
}

pub fn emitModuleDoneMain(e: *Emitter) Error!void {
    try emitDoneCallback(e, "_jsrt_module_done", &.{ "jsrt_throw(value);", "jsrt_uncaught();" });
}

pub fn emitAsyncModuleForward(e: *Emitter) Error!void {
    try e.appendLine("static void _jsrt_async_module(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err);", null);
    try e.appendLine("", null);
}

pub fn emitAsyncModuleBody(e: *Emitter, module: *const Module) Error!void {
    try e.openBlock("static void _jsrt_async_module(JSRTAsync *_jsrt_self, jsrt_value _jsrt_v, bool _jsrt_err) {", null);
    try e.emitResumeOpen(module.span, &.{ "_jsrt_v", "_jsrt_err" });
    for (module.statements) |stmt| try e.emitStatement(stmt);
    try e.emitAsyncSettle("jsrt_async_return", "JSRT_UNDEFINED", module.span);
    if (e.unwind_used) {
        try e.appendLine("_jsrt_unwind: ;", module.span);
        const slot = try e.slotAt(e.return_slot);
        try e.line(module.span, "{s} = jsrt_take_exception();", .{slot});
        try e.emitAsyncSettle("jsrt_async_throw", slot, module.span);
    }
    try e.closeBlock(null);
}

pub fn emitLibrary(e: *Emitter, module: *const Module, library: LibraryEmit, global_slots: usize, scratch: usize) Error![]const []const u8 {
    beginModuleUnits(e);
    try e.emitExportConstDefs(library);
    try e.emitErrorCell(library);
    if (module.is_async) {
        const env_slots = try e.countAsyncModule(module);
        try e.emitInitDone(scratch);
        try e.emitAsyncModuleForward();
        try e.emitLibraryInitAsync(module, library, global_slots, env_slots, scratch);
        try e.emitAsyncModuleBody(module);
    } else {
        try e.emitLibraryInitSync(module, library, global_slots, scratch);
    }
    for (library.exports.functions) |function| try e.emitExportStub(library, function, scratch, module.span);
    return e.lines.items;
}

pub fn emitExportConstDefs(e: *Emitter, library: LibraryEmit) Error!void {
    if (library.exports.consts.len == 0) return;
    try e.appendLine("/* Exported consts: C views of module globals, stored by the init below. */", null);
    for (library.exports.consts) |constant| try e.appendLine(try e.fmt("{s} {s};", .{ constant.c_type, constant.c_name }), null);
    try e.appendLine("", null);
}

pub fn emitErrorCell(e: *Emitter, library: LibraryEmit) Error!void {
    const unit = library.unit;
    try e.appendLine(try e.fmt("static _Thread_local char *_stator_{s}_last_error_msg = NULL;", .{unit}), null);
    try e.openBlock(try e.fmt("static void _stator_{s}_error_clear(void) {{", .{unit}), null);
    try e.line(null, "free(_stator_{s}_last_error_msg);", .{unit});
    try e.line(null, "_stator_{s}_last_error_msg = NULL;", .{unit});
    try e.closeBlock(null);
    try e.openBlock(try e.fmt("static void _stator_{s}_error_capture(jsrt_value _stator_error) {{", .{unit}), null);
    try e.appendLine("jsrt_value _stator_text = jsrt_to_string(_stator_error);", null);
    try e.openBlock("if (jsrt_pending()) {", null);
    try e.appendLine("(void)jsrt_take_exception();", null);
    try e.appendLine("_stator_text = jsrt_builtin_to_string(_stator_error);", null);
    try e.closeBlock(null);
    try e.line(null, "free(_stator_{s}_last_error_msg);", .{unit});
    try e.line(null, "_stator_{s}_last_error_msg = jsrt_string_to_cstr(_stator_text);", .{unit});
    try e.closeBlock(null);
    try e.openBlock(try e.fmt("const char *{s}(void) {{", .{try literals.exportLastErrorName(e.arena, unit)}), null);
    try e.line(null, "return _stator_{s}_last_error_msg;", .{unit});
    try e.closeDefinition();
}

pub fn emitExportConstStores(e: *Emitter, library: LibraryEmit, span: Span) Error!void {
    for (library.exports.consts) |constant| {
        const slot = try e.exportSlot("const", constant.name);
        const global = try e.fmt("JSRT_GLOBAL({d})", .{slot});
        const stored = if (std.mem.eql(u8, constant.c_type, "double"))
            try e.fmt("jsrt_to_number({s})", .{global})
        else if (std.mem.eql(u8, constant.c_type, "bool"))
            try e.fmt("jsrt_as_bool({s})", .{global})
        else if (std.mem.eql(u8, constant.c_type, "const char *"))
            try e.fmt("jsrt_string_to_cstr({s})", .{global})
        else if (std.mem.eql(u8, constant.c_type, "jsrt_value"))
            global
        else
            return e.fail("exported const has no C store: {s}", .{constant.c_type});
        try e.line(span, "{s} = {s};", .{ constant.c_name, stored });
    }
}

pub fn exportSlot(e: *Emitter, kind: []const u8, name: []const u8) Error!usize {
    return e.global_map.get(name) orelse e.fail("exported {s} '{s}' has no module slot", .{ kind, name });
}

pub fn emitInitOpen(e: *Emitter, unit: []const u8, span: Span, global_slots: usize) Error!void {
    try e.appendLine(try e.fmt("static bool _stator_{s}_initialized = false;", .{unit}), null);
    try e.appendLine("", null);
    try e.openBlock(try e.fmt("void {s}(void) {{", .{try literals.exportInitName(e.arena, unit)}), null);
    try e.openBlock(try e.fmt("if (_stator_{s}_initialized) {{", .{unit}), span);
    try e.appendLine("return;", span);
    try e.closeBlock(span);
    try e.line(span, "_stator_{s}_initialized = true;", .{unit});
    try e.appendLine("jsrt_init();", span);
    try e.line(span, "JSRT_GLOBALS_ENTER({d});", .{global_slots});
}

pub fn emitLibraryInitSync(e: *Emitter, module: *const Module, library: LibraryEmit, global_slots: usize, scratch: usize) Error!void {
    const span = module.span;
    try e.emitInitOpen(library.unit, span, global_slots);
    try e.emitModuleEnv(module);
    try e.emitSyncTopLevelStatements(module);
    try e.emitMicrotaskDrain(module);
    try e.emitExportConstStores(library, span);
    try e.appendLine("return;", span);
    if (e.unwind_used) {
        try e.appendLine("_jsrt_unwind: ;", span);
        try e.line(span, "JSRT_GLOBAL({d}) = jsrt_take_exception();", .{scratch});
        try e.line(span, "_stator_{s}_error_capture(JSRT_GLOBAL({d}));", .{ library.unit, scratch });
        try e.appendLine("return;", span);
    }
    try e.closeDefinition();
}

pub fn emitInitDone(e: *Emitter, scratch: usize) Error!void {
    try e.appendLine("static bool _jsrt_init_rejected = false;", null);
    try emitDoneCallback(e, "_jsrt_init_done", &.{ "_jsrt_init_rejected = true;", try e.fmt("JSRT_GLOBAL({d}) = value;", .{scratch}) });
}

pub fn emitAsyncModuleRun(e: *Emitter, module: *const Module, env_slots: usize, on_done: []const u8) Error!void {
    const span = module.span;
    try e.emitHoistedFunctions(module.statements);
    try e.appendLine("JSRT_FRAME(1);", span);
    try e.line(span, "JSRTEnv *_jsrt_env = jsrt_env_new(NULL, {d});", .{env_slots});
    try e.appendLine("JSRT_FRAME_ENV(_jsrt_env);", span);
    try e.appendLine("JSRT_LOCAL(0) = jsrt_async_start(_jsrt_env, _jsrt_async_module);", span);
    try e.line(span, "jsrt_promise_subscribe(JSRT_LOCAL(0), {s}, NULL);", .{on_done});
    try e.appendLine("jsrt_run_microtasks();", span);
    try e.appendLine("JSRT_FRAME_POP();", span);
}

pub fn emitLibraryInitAsync(e: *Emitter, module: *const Module, library: LibraryEmit, global_slots: usize, env_slots: usize, scratch: usize) Error!void {
    const span = module.span;
    try e.emitInitOpen(library.unit, span, global_slots);
    try e.emitAsyncModuleRun(module, env_slots, "_jsrt_init_done");
    try e.openBlock("if (_jsrt_init_rejected) {", span);
    try e.line(span, "_stator_{s}_error_capture(JSRT_GLOBAL({d}));", .{ library.unit, scratch });
    try e.appendLine("return;", span);
    try e.closeBlock(span);
    try e.emitExportConstStores(library, span);
    try e.appendLine("return;", span);
    try e.closeDefinition();
}

pub fn emitExportStub(e: *Emitter, library: LibraryEmit, function: ExportedFunction, scratch: usize, span: Span) Error!void {
    const unit = library.unit;
    const slot = try e.exportSlot("function", function.name);
    const returns_void = std.mem.eql(u8, function.ret, "void");
    var params: emitter.Parts = .empty;
    for (function.params) |param| try params.append(e.arena, try e.fmt("{s} {s}", .{ param.c_type, param.name }));
    const param_list = if (function.params.len == 0) "void" else try e.join(params.items);
    try e.openBlock(try e.fmt("{s} {s}({s}) {{", .{ function.ret, function.c_name, param_list }), null);
    const frame_slots = @max(function.params.len + @as(usize, if (returns_void) 0 else 1), 1);
    try e.line(span, "JSRT_FRAME({d});", .{frame_slots});
    try e.line(span, "_stator_{s}_error_clear();", .{unit});
    for (function.params, 0..) |param, index| {
        if (std.mem.eql(u8, param.c_type, "const char *")) {
            try e.openBlock(try e.fmt("if ({s} == NULL) {{", .{param.name}), span);
            try e.line(span, "jsrt_throw_error(&jsrt_class_type_error, \"stator: NULL for string parameter '{s}' of exported function '{s}'\");", .{
                try literals.escapeCString(e.arena, param.name),
                try literals.escapeCString(e.arena, function.name),
            });
            try e.appendLine("goto _jsrt_err;", span);
            try e.closeBlock(span);
        }
        try e.line(span, "JSRT_LOCAL({d}) = {s};", .{ index, try exportArg(e, param.c_type, param.name) });
    }
    if (returns_void) {
        try e.line(span, "jsrt_call(JSRT_GLOBAL({d}), {d}, _jsrt_slots);", .{ slot, function.params.len });
    } else {
        try e.line(span, "JSRT_LOCAL({d}) = jsrt_call(JSRT_GLOBAL({d}), {d}, _jsrt_slots);", .{ function.params.len, slot, function.params.len });
    }
    try e.openBlock("if (jsrt_pending()) {", span);
    try e.appendLine("goto _jsrt_err;", span);
    try e.closeBlock(span);
    if (!returns_void) {
        try e.line(span, "{s} _jsrt_ret = {s};", .{ function.ret, try exportRet(e, function.ret, function.params.len, scratch) });
    }
    try e.appendLine("JSRT_FRAME_POP();", span);
    try e.appendLine(if (returns_void) "return;" else "return _jsrt_ret;", span);
    try e.appendLine("_jsrt_err: ;", span);
    try e.line(span, "JSRT_GLOBAL({d}) = jsrt_take_exception();", .{scratch});
    try e.line(span, "_stator_{s}_error_capture(JSRT_GLOBAL({d}));", .{ unit, scratch });
    try e.appendLine("JSRT_FRAME_POP();", span);
    if (returns_void) {
        try e.appendLine("return;", span);
    } else {
        try e.line(span, "return {s};", .{try exportSentinel(e, function.ret)});
    }
    try e.closeDefinition();
}

fn exportArg(e: *Emitter, c_type: []const u8, name: []const u8) Error![]const u8 {
    if (std.mem.eql(u8, c_type, "double")) return e.fmt("jsrt_number({s})", .{name});
    if (std.mem.eql(u8, c_type, "bool")) return e.fmt("jsrt_bool({s})", .{name});
    if (std.mem.eql(u8, c_type, "const char *")) return e.fmt("jsrt_string_from_cstr({s})", .{name});
    if (std.mem.eql(u8, c_type, "void *")) return e.fmt("(jsrt_value)(uintptr_t)({s})", .{name});
    if (std.mem.eql(u8, c_type, "jsrt_value")) return name;
    return e.fail("exported parameter has no C passing: {s}", .{c_type});
}

fn exportRet(e: *Emitter, c_type: []const u8, slot: usize, scratch: usize) Error![]const u8 {
    const value = try e.fmt("JSRT_LOCAL({d})", .{slot});
    if (std.mem.eql(u8, c_type, "double")) return e.fmt("jsrt_to_number({s})", .{value});
    if (std.mem.eql(u8, c_type, "bool")) return e.fmt("jsrt_as_bool({s})", .{value});
    if (std.mem.eql(u8, c_type, "const char *")) return e.fmt("jsrt_string_to_cstr({s})", .{value});
    if (std.mem.eql(u8, c_type, "void *")) return e.fmt("jsrt_ptr({s})", .{value});
    if (std.mem.eql(u8, c_type, "jsrt_value")) return e.fmt("JSRT_GLOBAL({d}) = {s}", .{ scratch, value });
    return e.fail("exported return has no C answer: {s}", .{c_type});
}

fn exportSentinel(e: *Emitter, c_type: []const u8) Error![]const u8 {
    if (std.mem.eql(u8, c_type, "double")) return "0.0";
    if (std.mem.eql(u8, c_type, "bool")) return "false";
    if (std.mem.eql(u8, c_type, "const char *") or std.mem.eql(u8, c_type, "void *")) return "NULL";
    if (std.mem.eql(u8, c_type, "jsrt_value")) return "JSRT_UNDEFINED";
    return e.fail("exported return has no sentinel: {s}", .{c_type});
}
