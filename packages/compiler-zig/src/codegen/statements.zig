//! Statement emission. Mirrors `packages/compiler/src/codegen/statements.ts`, which keeps the
//! reasoning; the generated C is compared with it byte for byte, so the order of every append and
//! every label or slot claim here is part of the contract.

const std = @import("std");
const nodes = @import("../hir/nodes.zig");
const emitter = @import("emitter.zig");
const helpers = @import("helpers.zig");
const literals = @import("literals.zig");

const Emitter = emitter.Emitter;
const Error = emitter.Error;
const Captured = emitter.Captured;
const Span = nodes.Span;
const Statement = nodes.Statement;
const Expression = nodes.Expression;
const iter_kinds = helpers.iter_kinds;

/// A compact condition stays on the `while (...)` line; one that needed statements becomes
/// `while (1)` plus a goto test.
fn openCapturedWhile(e: *Emitter, id: usize, span: Span, cond: ?Captured) Error!void {
    if (cond == null or cond.?.lines.len == 0) {
        const test_text = if (cond) |c| try e.fmt("jsrt_truthy({s})", .{c.value}) else "1";
        try e.line(span, "while ({s}) {{", .{test_text});
        e.indent += 1;
        return;
    }
    try e.line(span, "while (1) {{", .{});
    e.indent += 1;
    try e.pushLines(cond.?.lines);
    try e.useLabel(try e.fmt("brk_{d}", .{id}));
    try e.line(span, "if (!jsrt_truthy({s})) {{ goto brk_{d}; }}", .{ cond.?.value, id });
}

fn openLoop(e: *Emitter, stmt: Statement, label: ?[]const u8, per_iteration_env: ?bool, span: Span) Error!usize {
    const id = try e.enterLoop(stmt, label, per_iteration_env);
    try e.emitIterEnvOpen(id, span);
    return id;
}

/// The condition is captured one level in, where its statements land inside `while (1)`.
fn openWhileLoop(e: *Emitter, stmt: Statement, label: ?[]const u8, per_iteration_env: ?bool, span: Span, condition: ?Expression) Error!usize {
    const id = try openLoop(e, stmt, label, per_iteration_env, span);
    e.indent += 1;
    const cond: ?Captured = if (condition) |c| try e.captureExpression(c) else null;
    e.indent -= 1;
    try openCapturedWhile(e, id, span, cond);
    return id;
}

fn emitLoopBody(e: *Emitter, id: usize, span: Span, statements: []const Statement) Error!void {
    try e.emitIterEnvSwap(id, span, .enter);
    try e.emitScope(statements);
    try e.emitJumpTarget(try e.fmt("cont_{d}", .{id}), span);
    try e.emitIterEnvSwap(id, span, .commit);
}

fn closeLoopScope(e: *Emitter, id: usize, span: Span) Error!void {
    try e.closeBlock(span);
    try e.emitJumpTarget(try e.fmt("brk_{d}", .{id}), span);
    _ = e.enclosing.pop();
}

fn pushFinallyScope(e: *Emitter, fin: []const u8, comp_var: []const u8, comp_boxed: bool) Error!*emitter.TryFinallyScope {
    const scope = try e.arena.create(emitter.TryFinallyScope);
    scope.* = .{
        .comp_var = comp_var,
        .comp_boxed = comp_boxed,
        .fin_label = fin,
        // Minus one: the for-of's own entry is already pushed, and `continue` stays inside.
        .enclosing_depth = e.enclosing.items.len - 1,
    };
    try e.try_finally_stack.append(e.arena, scope);
    return scope;
}

/// `comp` holds a boxed number or a raw C int; the two completion cells route the same jumps.
fn emitFinallyDispatch(e: *Emitter, scope: *emitter.TryFinallyScope, comp: []const u8, span: Span) Error!void {
    for (scope.routes.values()) |route| {
        if (scope.comp_boxed) {
            try e.line(span, "if (jsrt_number_value({s}) == {d}) {{", .{ comp, route.code });
        } else {
            try e.line(span, "if ({s} == {d}) {{", .{ comp, route.code });
        }
        e.indent += 1;
        try e.runRoute(route.action);
        try e.closeBlock(span);
    }
}

/// `^(?:JSRT_(?:LOCAL|GLOBAL)\(\d+\)|_jsrt_env->slots\[\d+\])$`: a call already ran as statements
/// and left only its slot, and a bare slot read as a line is a no-op clang warns about.
fn isBareSlot(text: []const u8) bool {
    const forms = [_]struct { open: []const u8, close: u8 }{
        .{ .open = "JSRT_LOCAL(", .close = ')' },
        .{ .open = "JSRT_GLOBAL(", .close = ')' },
        .{ .open = "_jsrt_env->slots[", .close = ']' },
    };
    for (forms) |form| {
        if (!std.mem.startsWith(u8, text, form.open) or text[text.len - 1] != form.close) continue;
        const digits = text[form.open.len .. text.len - 1];
        if (digits.len == 0) continue;
        for (digits) |c| {
            if (!std.ascii.isDigit(c)) break;
        } else return true;
    }
    return false;
}

pub fn emitStatement(e: *Emitter, stmt: Statement) Error!void {
    if (e.threaded()) try e.appendLine("jsrt_gc_safepoint();", stmt.getSpan());
    switch (stmt) {
        .declaration => |s| {
            if (s.value) |value_expr| {
                const value = try e.emitExpression(value_expr);
                try e.line(s.span, "{s} = {s};", .{ try e.slotRef(s.name), value });
            }
        },
        .assignment => |s| {
            const value = try e.emitExpression(s.value);
            try e.line(s.span, "{s} = {s};", .{ try e.slotRef(s.target), value });
        },
        .expression_statement => |s| {
            switch (s.expression) {
                .console_log => |call| {
                    try e.line(s.span, "{s};", .{try e.consoleCall(call)});
                    if (nodes.consoleMayThrow(call)) try e.emitPendingCheck(s.span);
                    return;
                },
                .extern_call => {
                    _ = try e.emitExpression(s.expression);
                    return;
                },
                else => {},
            }
            const expr = try e.emitExpression(s.expression);
            if (!isBareSlot(expr)) try e.line(s.span, "{s};", .{expr});
        },
        .if_statement => |s| {
            const cond = try e.emitExpression(s.condition);
            try e.line(s.span, "if (jsrt_truthy({s})) {{", .{cond});
            e.indent += 1;
            try e.emitScope(s.consequent.statements);
            e.indent -= 1;
            if (s.alternate) |alternate| {
                try e.openBlock("} else {", s.span);
                try e.emitScope(alternate.statements);
                e.indent -= 1;
            }
            try e.appendLine("}", s.span);
        },
        .while_statement => |s| {
            const id = try openWhileLoop(e, stmt, s.label, s.per_iteration_env, s.span, s.condition);
            try emitLoopBody(e, id, s.span, s.body.statements);
            try closeLoopScope(e, id, s.span);
        },
        .do_while_statement => |s| {
            const id = try openLoop(e, stmt, s.label, s.per_iteration_env, s.span);
            try e.openBlock("do {", s.span);
            try emitLoopBody(e, id, s.span, s.body.statements);
            const cond = try e.captureExpression(s.condition);
            if (cond.lines.len == 0) {
                e.indent -= 1;
                try e.line(s.span, "}} while (jsrt_truthy({s}));", .{cond.value});
            } else {
                try e.pushLines(cond.lines);
                try e.useLabel(try e.fmt("brk_{d}", .{id}));
                try e.line(s.span, "if (!jsrt_truthy({s})) {{ goto brk_{d}; }}", .{ cond.value, id });
                e.indent -= 1;
                try e.appendLine("} while (1);", s.span);
            }
            try e.emitJumpTarget(try e.fmt("brk_{d}", .{id}), s.span);
            _ = e.enclosing.pop();
        },
        .for_statement => |s| {
            if (s.init) |init_statement| try e.emitStatement(init_statement);
            const id = try openWhileLoop(e, stmt, s.label, s.per_iteration_env, s.span, s.condition);
            try e.emitIterEnvSwap(id, s.span, .enter);
            try e.emitScope(s.body.statements);
            // Before the update: `continue` must still run `i++`.
            try e.emitJumpTarget(try e.fmt("cont_{d}", .{id}), s.span);
            // Before the update too, so `i++` mutates the control env and not the body's clone.
            try e.emitIterEnvSwap(id, s.span, .commit);
            if (s.update) |update| try e.emitStatement(update);
            try closeLoopScope(e, id, s.span);
        },
        .switch_statement => |s| try e.emitSwitch(s),
        .break_statement => |s| try emitBreakOrContinue(e, s.label, false, s.span),
        .continue_statement => |s| try emitBreakOrContinue(e, s.label, true, s.span),
        .block => |s| {
            if (s.label) |label| {
                const id = try e.enterBreakable(label);
                try e.emitScope(s.statements);
                try e.emitJumpTarget(try e.fmt("brk_{d}", .{id}), s.span);
                _ = e.enclosing.pop();
                return;
            }
            try e.emitScope(s.statements);
        },
        .function_declaration => {},
        .index_assignment => |s| {
            const base = try e.slotOf(&e.index_slots, s, "index assignment was not registered during counting");
            const target = try e.slotAt(base);
            const index = try e.slotAt(base + 1);
            const value = try e.slotAt(base + 2);
            try e.line(s.span, "{s} = {s};", .{ target, try e.emitExpression(s.target) });
            try e.line(s.span, "{s} = {s};", .{ index, try e.emitExpression(s.index) });
            try e.line(s.span, "{s} = {s};", .{ value, try e.emitExpression(s.value) });
            const set = try helpers.indexSetCall(e.arena, s.target.getType(), target, index, value);
            try e.line(s.span, "{s};", .{set});
            try e.emitPendingCheck(s.span);
        },
        .for_of_statement => |s| try emitForOf(e, stmt, s),
        .return_statement => |s| try emitReturn(e, s),
        inline .field_assignment, .dyn_field_assignment => |s| try e.emitFieldWrite(s),
        .super_call => |s| {
            const ctor = (try e.classAt(s.class_name)).ctor orelse return;
            const base = try e.slotOf(&e.call_slots, s, "super call was not registered during counting");
            var parts: emitter.Parts = .empty;
            _ = try e.sequenceAssign(&parts, s.receiver, s.span, base);
            for (s.args, 0..) |arg, index| {
                _ = try e.sequenceAssign(&parts, arg, s.span, base + 1 + index);
            }
            try parts.append(e.arena, try helpers.receiverCall(e.arena, try e.closureValue(ctor.@"fn"), try e.slotAt(base), s.args.len));
            try e.flushParts(&parts, s.span);
            try e.emitPendingCheck(s.span);
        },
        .class_declaration => |s| {
            // A static is live from the class declaration onward, which is why it emits here.
            for (s.statics) |decl| try e.emitStatement(.{ .declaration = decl });
        },
        .throw_statement => |s| {
            const value = try e.emitExpression(s.value);
            try e.line(s.span, "jsrt_throw({s});", .{value});
            try e.line(s.span, "goto {s};", .{try e.currentPad()});
        },
        .try_statement => |s| try e.emitTry(s),
    }
}

fn emitBreakOrContinue(e: *Emitter, label: ?[]const u8, wants_loop: bool, span: Span) Error!void {
    var index = e.enclosing.items.len;
    while (index > 0) {
        index -= 1;
        const open = e.enclosing.items[index];
        if (wants_loop and !open.is_loop) continue;
        if (label) |wanted| {
            const have = open.label orelse continue;
            if (!std.mem.eql(u8, have, wanted)) continue;
        }
        const name = try e.fmt("{s}_{d}", .{ if (wants_loop) "cont" else "brk", open.id });
        return e.emitLoopJump(name, index, span);
    }
    return e.fail("jump has no enclosing target; verifier should have caught it", .{});
}

fn emitForOf(e: *Emitter, stmt: Statement, s: *const nodes.ForOfStatement) Error!void {
    const slot = try e.slotOf(&e.for_of_slots, s, "for-of has no iterable slot; countBindings missed a node");
    const iterable = try e.slotAt(slot);
    try e.line(s.span, "{s} = {s};", .{ iterable, try e.emitExpression(s.iterable) });
    const iterable_type = s.iterable.getType();
    if (iterable_type.* == .array) {
        try e.line(s.span, "jsrt_require_array_iterable({s});", .{iterable});
        try e.emitPendingCheck(s.span);
    }
    const id = try openLoop(e, stmt, s.label, s.per_iteration_env, s.span);
    const boxed = e.forOfIsBoxed(s);
    if (boxed and iterable_type.* != .iterator) {
        const box: ?u32 = switch (iterable_type.*) {
            .map => iter_kinds.map.entries,
            .set => iter_kinds.set.values,
            .string => iter_kinds.string,
            .array => iter_kinds.array.values,
            else => null,
        };
        if (box) |kind| try e.line(s.span, "{s} = jsrt_iterator_new({s}, {d});", .{ iterable, iterable, kind });
    }
    if (boxed) return e.emitBoxedIteratorForOf(s, iterable, id);
    if (iterable_type.* == .map or iterable_type.* == .set) return e.emitMapSetForOf(s, iterable, id);

    const cursor = try e.fmt("jsrt_iter_{d}", .{id});
    if (iterable_type.* == .string) {
        try e.line(s.span, "for (uint32_t {s} = 0; {s} < jsrt_string_length({s}); ) {{", .{ cursor, cursor, iterable });
        e.indent += 1;
        try e.line(s.span, "{s} = jsrt_string_iter_next({s}, &{s});", .{ try e.slotRef(s.binding), iterable, cursor });
    } else {
        try e.line(s.span, "for (uint32_t {s} = 0; {s} < jsrt_as_array({s})->length; {s}++) {{", .{ cursor, cursor, iterable, cursor });
        e.indent += 1;
        try e.emitArrayForOfYield(s, iterable, cursor);
    }
    try emitLoopBody(e, id, s.span, s.body.statements);
    try closeLoopScope(e, id, s.span);
}

fn emitReturn(e: *Emitter, s: *const nodes.ReturnStatement) Error!void {
    if (!e.in_function) return e.fail("return outside a function; verifier should have caught it", .{});
    const slot = try e.slotAt(e.return_slot);
    const value_expr = s.value orelse {
        if (e.try_finally_stack.items.len == 0) {
            if (e.in_async) return e.emitAsyncSettle("jsrt_async_return", "JSRT_UNDEFINED", s.span);
            if (e.in_generator) return e.emitGeneratorSettle("JSRT_UNDEFINED", s.span);
            try e.appendLine("JSRT_FRAME_POP();", s.span);
            try e.appendLine("return JSRT_UNDEFINED;", s.span);
            return;
        }
        // An enclosing finally must run first: park the value, route only the jump.
        try e.line(s.span, "{s} = JSRT_UNDEFINED;", .{slot});
        return e.emitReturnJump(s.span);
    };
    const value = try e.emitExpression(value_expr);
    if (e.try_finally_stack.items.len != 0) {
        try e.line(s.span, "{s} = {s};", .{ slot, value });
        return e.emitReturnJump(s.span);
    }
    // Evaluate into a rooted slot first, pop second, read third: popping earlier would run the
    // expression's allocations with this frame's locals invisible to the collector.
    if (e.in_async) {
        try e.line(s.span, "{s} = {s};", .{ slot, value });
        return e.emitAsyncSettle("jsrt_async_return", slot, s.span);
    }
    if (e.in_generator) {
        try e.line(s.span, "{s} = {s};", .{ slot, value });
        return e.emitGeneratorSettle(slot, s.span);
    }
    const handoff = if (e.threaded()) try e.fmt("jsrt_gc_handoff({s}), ", .{slot}) else "";
    try e.line(s.span, "return ({s} = {s}, {s}JSRT_FRAME_POP(), {s});", .{ slot, value, handoff, slot });
}

/// Leaves the protected body for the finally: pop the throw pad, jump to fin, and place the thr
/// label when the body actually registered it.
fn openFinallyTail(e: *Emitter, fin: []const u8, fin_thr: []const u8, span: Span) Error!bool {
    _ = e.pad_stack.pop();
    try e.useLabel(fin);
    try e.line(span, "goto {s};", .{fin});
    if (!e.labelUsed(fin_thr)) return false;
    try e.line(span, "{s}: ;", .{fin_thr});
    return true;
}

/// Where a loop's `break` lands and its finally starts: past here the loop's jumps no longer route.
fn placeFinally(e: *Emitter, id: usize, fin: []const u8, span: Span) Error!void {
    try e.emitJumpTarget(try e.fmt("brk_{d}", .{id}), span);
    _ = e.try_finally_stack.pop();
    try e.line(span, "{s}: ;", .{fin});
}

fn closeFinallyLoop(e: *Emitter, span: Span) Error!void {
    try e.closeBlock(span);
    _ = e.enclosing.pop();
}

fn emitLoopBodyAndClose(e: *Emitter, id: usize, span: Span, statements: []const Statement) Error!void {
    try emitLoopBody(e, id, span, statements);
    try e.closeBlock(span);
}

pub fn emitMapSetForOf(e: *Emitter, stmt: *const nodes.ForOfStatement, iterable: []const u8, id: usize) Error!void {
    const span = stmt.span;
    const cursor = try e.fmt("jsrt_iter_{d}", .{id});
    const key = try e.fmt("_jsrt_k_{d}", .{id});
    const val = try e.fmt("_jsrt_v_{d}", .{id});
    const coll = try e.fmt("_jsrt_coll_{d}", .{id});
    // A bare `return` through this cleanup parks `undefined` in `return_slot`, the iterable's own
    // index when the function returns no value, so `iter_end` reads a C local instead.
    try e.line(span, "jsrt_value {s} = {s};", .{ coll, iterable });
    try e.line(span, "jsrt_map_iter_begin({s});", .{coll});

    const try_id = e.try_count;
    e.try_count += 1;
    const comp = try e.fmt("_jsrt_mapcomp_{d}", .{try_id});
    const fin = try e.fmt("_jsrt_mapfin_{d}", .{try_id});
    const fin_thr = try e.fmt("_jsrt_mapfinthr_{d}", .{try_id});
    try e.openBlock("{", span);
    try e.line(span, "int {s} = 0;", .{comp});
    const scope = try pushFinallyScope(e, fin, comp, false);
    try e.pad_stack.append(e.arena, fin_thr);

    try e.line(span, "jsrt_value {s};", .{key});
    try e.line(span, "jsrt_value {s};", .{val});
    try e.line(span, "for (uint32_t {s} = 0; jsrt_map_iter_step({s}, &{s}, &{s}, &{s}); ) {{", .{ cursor, coll, cursor, key, val });
    e.indent += 1;
    try e.emitMapSetForOfYield(stmt, key, val);
    try emitLoopBodyAndClose(e, id, span, stmt.body.statements);

    if (try openFinallyTail(e, fin, fin_thr, span)) {
        try e.line(span, "jsrt_map_iter_end({s});", .{coll});
        try e.line(span, "goto {s};", .{try e.currentPad()});
    }
    try placeFinally(e, id, fin, span);
    try e.line(span, "jsrt_map_iter_end({s});", .{coll});
    try emitFinallyDispatch(e, scope, comp, span);
    try closeFinallyLoop(e, span);
}

pub fn emitArrayForOfYield(e: *Emitter, stmt: *const nodes.ForOfStatement, iterable: []const u8, cursor: []const u8) Error!void {
    const bind = try e.slotRef(stmt.binding);
    if (stmt.view == .keys) {
        try e.line(stmt.span, "{s} = jsrt_number((double){s});", .{ bind, cursor });
        return;
    }
    const element = try e.fmt("jsrt_unhole(jsrt_as_array({s})->elements[{s}])", .{ iterable, cursor });
    if (stmt.view == .entries) {
        const pair = try e.fmt("_jsrt_pair_{s}", .{cursor});
        try e.line(stmt.span, "jsrt_value {s}[2] = {{ jsrt_number((double){s}), {s} }};", .{ pair, cursor, element });
        try e.line(stmt.span, "{s} = jsrt_array_new(2, {s});", .{ bind, pair });
        return;
    }
    try e.line(stmt.span, "{s} = {s};", .{ bind, element });
}

pub fn emitMapSetForOfYield(e: *Emitter, stmt: *const nodes.ForOfStatement, key: []const u8, val: []const u8) Error!void {
    const bind = try e.slotRef(stmt.binding);
    const map = stmt.iterable.getType().* == .map;
    if (stmt.view == .keys or (!map and stmt.view != .entries)) {
        try e.line(stmt.span, "{s} = {s};", .{ bind, key });
        return;
    }
    if (stmt.view == .values and map) {
        try e.line(stmt.span, "{s} = {s};", .{ bind, val });
        return;
    }
    const pair = try e.fmt("_jsrt_pair_{s}", .{key});
    const second = if (map) val else key;
    try e.line(stmt.span, "jsrt_value {s}[2] = {{ {s}, {s} }};", .{ pair, key, second });
    try e.line(stmt.span, "{s} = jsrt_array_new(2, {s});", .{ bind, pair });
}

/// Counting and emission both ask this one predicate, so the cleanup triple is claimed exactly when
/// the boxed arm takes it.
pub fn forOfIsBoxed(e: *const Emitter, stmt: *const nodes.ForOfStatement) bool {
    const kind = stmt.iterable.getType().*;
    if (kind == .iterator) return true;
    if (!e.in_async and !e.in_generator) return false;
    return kind == .map or kind == .set or kind == .array or kind == .string;
}

pub fn emitBoxedIteratorForOf(e: *Emitter, stmt: *const nodes.ForOfStatement, iterable: []const u8, id: usize) Error!void {
    const span = stmt.span;
    const close_base = try e.slotOf(&e.for_of_close_slots, stmt, "boxed for-of has no close slots; countBindings missed a node");
    const iter_copy = try e.slotAt(close_base);
    const exc = try e.slotAt(close_base + 1);
    const comp = try e.slotAt(close_base + 2);
    const item = try e.fmt("_jsrt_item_{d}", .{id});
    // The fin must not read the iterable slot itself: see the counting arm.
    try e.line(span, "{s} = {s};", .{ iter_copy, iterable });

    const try_id = e.try_count;
    e.try_count += 1;
    const fin = try e.fmt("_jsrt_forfin_{d}", .{try_id});
    const fin_thr = try e.fmt("_jsrt_forfinthr_{d}", .{try_id});
    try e.openBlock("{", span);
    try e.line(span, "{s} = jsrt_number(0);", .{comp});
    const scope = try pushFinallyScope(e, fin, comp, true);
    try e.pad_stack.append(e.arena, fin_thr);

    try e.line(span, "jsrt_value {s};", .{item});
    try e.appendLine("for (;;) {", span);
    e.indent += 1;
    try e.line(span, "if (!jsrt_iterator_step({s}, &{s})) {{", .{ iterable, item });
    e.indent += 1;
    // A generator's step can throw: false then means "stop and unwind", not "exhausted".
    try e.line(span, "if (jsrt_pending()) {{ goto {s}; }}", .{try e.currentPad()});
    try e.appendLine("break;", span);
    try e.closeBlock(span);
    try e.line(span, "{s} = {s};", .{ try e.slotRef(stmt.binding), item });
    try emitLoopBodyAndClose(e, id, span, stmt.body.statements);

    if (try openFinallyTail(e, fin, fin_thr, span)) {
        try e.line(span, "{s} = jsrt_number(1);", .{comp});
        // Taken before the close runs: a throwing close must find the cell empty to overwrite
        // while the original waits rooted.
        try e.line(span, "{s} = jsrt_take_exception();", .{exc});
        try e.line(span, "goto {s};", .{fin});
    }
    try placeFinally(e, id, fin, span);
    try e.line(span, "jsrt_iterator_close({s});", .{iter_copy});
    try e.openBlock("if (jsrt_pending()) {", span);
    try e.line(span, "if (jsrt_number_value({s}) == 1) {{", .{comp});
    e.indent += 1;
    try e.appendLine("(void)jsrt_take_exception();", span);
    try e.line(span, "jsrt_throw({s});", .{exc});
    try e.closeBlock(span);
    try e.line(span, "goto {s};", .{try e.currentPad()});
    try e.closeBlock(span);
    try e.line(span, "if (jsrt_number_value({s}) == 1) {{ jsrt_throw({s}); goto {s}; }}", .{ comp, exc, try e.currentPad() });
    try emitFinallyDispatch(e, scope, comp, span);
    try closeFinallyLoop(e, span);
}

/// `stmt` is what ties the loop to the two suspension slots counted for it: the id is minted here,
/// at emission time, and the slots had to exist before it.
pub fn enterLoop(e: *Emitter, stmt: Statement, label: ?[]const u8, per_iteration_env: ?bool) Error!usize {
    const id = e.loop_count;
    e.loop_count += 1;
    const iter_env = per_iteration_env == true and e.env_map.count() > 0;
    if (iter_env) {
        const base = try e.slotOf(&e.iter_env_slots, stmt.id(), "per-iteration loop was not counted; countBindings missed a node");
        try e.iter_env_base.put(e.arena, id, base);
    }
    try e.enclosing.append(e.arena, .{ .id = id, .is_loop = true, .label = label, .iter_env = iter_env });
    return id;
}

pub fn enterBreakable(e: *Emitter, label: []const u8) Error!usize {
    const id = e.loop_count;
    e.loop_count += 1;
    try e.enclosing.append(e.arena, .{ .id = id, .is_loop = false, .label = label });
    return id;
}

pub fn iterEnvOf(e: *const Emitter, id: usize) bool {
    for (e.enclosing.items) |open| {
        if (open.id == id and open.iter_env) return true;
    }
    return false;
}

pub fn frameEnvLine(e: *Emitter, env: []const u8) Error![]const u8 {
    return if (e.in_function) e.fmt("JSRT_FRAME_ENV({s});", .{env}) else e.fmt("JSRT_GLOBALS_ENV({s});", .{env});
}

const IterEnvState = struct { saved: []const u8, iter: []const u8 };

pub fn iterEnvState(e: *Emitter, id: usize) Error!IterEnvState {
    const base = e.iter_env_base.get(id) orelse
        return e.fail("per-iteration loop has no suspension slots; countBindings missed a node", .{});
    return .{ .saved = try e.slotAt(base), .iter = try e.slotAt(base + 1) };
}

pub fn emitIterEnvOpen(e: *Emitter, id: usize, span: Span) Error!void {
    if (!e.iterEnvOf(id)) return;
    const state = try e.iterEnvState(id);
    try e.line(span, "{s} = (jsrt_value)(uintptr_t)_jsrt_env;", .{state.saved});
    try e.line(span, "{s} = (jsrt_value)0;", .{state.iter});
}

pub const IterEnvSwap = enum { enter, commit };

/// Enter clones the loop's saved environment for one iteration; commit copies that iteration's
/// slots back. Each runs only once the environment it reads exists.
pub fn emitIterEnvSwap(e: *Emitter, id: usize, span: Span, comptime swap: IterEnvSwap) Error!void {
    if (!e.iterEnvOf(id)) return;
    const state = try e.iterEnvState(id);
    const guard = switch (swap) {
        .enter => state.saved,
        .commit => state.iter,
    };
    try e.openBlock(try e.fmt("if ({s} != (jsrt_value)0) {{", .{guard}), span);
    switch (swap) {
        .enter => {
            try e.line(span, "_jsrt_env = jsrt_env_clone((JSRTEnv *)(uintptr_t){s});", .{state.saved});
            try e.line(span, "{s} = (jsrt_value)(uintptr_t)_jsrt_env;", .{state.iter});
        },
        .commit => {
            try e.line(span, "jsrt_env_copy_slots((JSRTEnv *)(uintptr_t){s}, (JSRTEnv *)(uintptr_t){s});", .{ state.saved, state.iter });
            try e.line(span, "_jsrt_env = (JSRTEnv *)(uintptr_t){s};", .{state.saved});
        },
    }
    try e.appendLine(try e.frameEnvLine("_jsrt_env"), span);
    try e.closeBlock(span);
}

pub fn commitIterEnvs(e: *Emitter, from_index_inclusive: usize, span: Span) Error!void {
    var i = e.enclosing.items.len;
    while (i > from_index_inclusive) {
        i -= 1;
        const open = e.enclosing.items[i];
        if (open.iter_env) try e.emitIterEnvSwap(open.id, span, .commit);
    }
}

/// Written only if something jumps to it: clang warns on an unused label. The trailing `;` is not
/// cosmetic: before C23 a label must be followed by a statement.
pub fn emitJumpTarget(e: *Emitter, name: []const u8, span: Span) Error!void {
    if (e.labelUsed(name)) try e.line(span, "{s}: ;", .{name});
}

/// Asking marks the pad used, which decides whether the tail or a catch is emitted at all.
pub fn currentPad(e: *Emitter) Error![]const u8 {
    const pad = e.pad_stack.getLastOrNull() orelse {
        e.unwind_used = true;
        return "_jsrt_unwind";
    };
    try e.useLabel(pad);
    return pad;
}

pub fn emitLoopJump(e: *Emitter, name: []const u8, target_index: usize, span: Span) Error!void {
    if (e.try_finally_stack.getLastOrNull()) |scope| {
        if (scope.enclosing_depth > target_index) {
            return e.routeJump(scope, name, span, .{ .loop_jump = .{ .name = name, .target_index = target_index, .span = span } });
        }
    }
    const continuing = std.mem.startsWith(u8, name, "cont_");
    try e.commitIterEnvs(if (continuing) target_index + 1 else target_index, span);
    try e.useLabel(name);
    try e.line(span, "goto {s};", .{name});
}

pub fn emitReturnJump(e: *Emitter, span: Span) Error!void {
    const scope = e.try_finally_stack.getLastOrNull() orelse {
        try e.commitIterEnvs(0, span);
        const slot = try e.slotAt(e.return_slot);
        if (e.in_async) return e.emitAsyncSettle("jsrt_async_return", slot, span);
        if (e.in_generator) return e.emitGeneratorSettle(slot, span);
        const handoff = if (e.threaded()) try e.fmt("jsrt_gc_handoff({s}), ", .{slot}) else "";
        try e.line(span, "return ({s}JSRT_FRAME_POP(), {s});", .{ handoff, slot });
        return;
    };
    try e.routeJump(scope, "return", span, .{ .return_jump = span });
}

/// Re-performs a recorded jump in a finally's dispatch, with that scope already popped, so a jump
/// crossing two finallys routes through both, innermost first.
pub fn runRoute(e: *Emitter, action: emitter.RouteAction) Error!void {
    switch (action) {
        .loop_jump => |jump| try e.emitLoopJump(jump.name, jump.target_index, jump.span),
        .return_jump => |span| try e.emitReturnJump(span),
    }
}

/// One code per distinct jump, allocated on first use. Codes 0 (normal) and 1 (throw) are reserved.
pub fn routeJump(e: *Emitter, scope: *emitter.TryFinallyScope, key: []const u8, span: Span, action: emitter.RouteAction) Error!void {
    const slot = try scope.routes.getOrPut(e.arena, key);
    if (!slot.found_existing) {
        slot.value_ptr.* = .{ .code = 2 + scope.routes.count() - 1, .action = action };
    }
    const code = slot.value_ptr.code;
    if (scope.comp_boxed) {
        try e.line(span, "{s} = jsrt_number({d});", .{ scope.comp_var, code });
    } else {
        try e.line(span, "{s} = {d};", .{ scope.comp_var, code });
    }
    try e.line(span, "goto {s};", .{scope.fin_label});
}

pub fn emitTry(e: *Emitter, stmt: *const nodes.TryStatement) Error!void {
    const id = e.try_count;
    e.try_count += 1;
    if (stmt.finally_block) |finally_block| {
        try e.emitTryFinally(stmt, finally_block, id);
    } else {
        try e.emitTryCatch(stmt, id);
    }
}

pub fn emitTryCatch(e: *Emitter, stmt: *const nodes.TryStatement, id: usize) Error!void {
    const catch_pad = try e.fmt("_jsrt_cat_{d}", .{id});
    try e.pad_stack.append(e.arena, catch_pad);
    try e.emitStatement(.{ .block = stmt.try_block });
    _ = e.pad_stack.pop();
    // No operation in the try body jumped to the pad, so the catch is unreachable. This rests on
    // every runtime call that can leave a pending exception being followed by a pending check.
    if (!e.labelUsed(catch_pad)) return;
    const end = try e.fmt("_jsrt_try_end_{d}", .{id});
    try e.useLabel(end);
    try e.line(stmt.span, "goto {s};", .{end});
    try e.line(stmt.span, "{s}: ;", .{catch_pad});
    try e.emitCatchEntry(stmt);
    if (stmt.catch_block) |catch_block| try e.emitStatement(.{ .block = catch_block });
    try e.line(stmt.span, "{s}: ;", .{end});
}

pub fn emitTryFinally(e: *Emitter, stmt: *const nodes.TryStatement, finally_block: *const nodes.Block, id: usize) Error!void {
    const fin_thr = try e.fmt("_jsrt_finthr_{d}", .{id});
    const fin = try e.fmt("_jsrt_fin_{d}", .{id});
    const exc_index = try e.slotOf(&e.try_slots, stmt, "try/finally has no exception slot; countBindings missed a node");
    const exc = try e.slotAt(exc_index);
    // A counted slot, boxed: a suspension between the route and the dispatch pops the C frame.
    const comp = try e.slotAt(exc_index + 1);
    try e.openBlock("{", stmt.span);
    try e.line(stmt.span, "{s} = jsrt_number(0);", .{comp});
    const scope = try e.arena.create(emitter.TryFinallyScope);
    scope.* = .{
        .comp_var = comp,
        .comp_boxed = true,
        .fin_label = fin,
        .enclosing_depth = e.enclosing.items.len,
    };
    try e.try_finally_stack.append(e.arena, scope);
    const catch_pad = if (stmt.catch_block == null) fin_thr else try e.fmt("_jsrt_cat_{d}", .{id});
    try e.pad_stack.append(e.arena, catch_pad);
    try e.emitStatement(.{ .block = stmt.try_block });
    _ = e.pad_stack.pop();
    try e.useLabel(fin);
    try e.line(stmt.span, "goto {s};", .{fin});
    if (stmt.catch_block) |catch_block| {
        if (e.labelUsed(catch_pad)) {
            try e.line(stmt.span, "{s}: ;", .{catch_pad});
            try e.emitCatchEntry(stmt);
            try e.pad_stack.append(e.arena, fin_thr);
            try e.emitStatement(.{ .block = catch_block });
            _ = e.pad_stack.pop();
            try e.line(stmt.span, "goto {s};", .{fin});
        }
    }
    // Pops here: a jump inside the finally body replaces the pending completion rather than
    // routing through this finally again.
    _ = e.try_finally_stack.pop();
    if (e.labelUsed(fin_thr)) {
        try e.line(stmt.span, "{s}: ;", .{fin_thr});
        try e.line(stmt.span, "{s} = jsrt_number(1);", .{comp});
        // Taken before the finally body runs: its own throw must find the cell empty.
        try e.line(stmt.span, "{s} = jsrt_take_exception();", .{exc});
    }
    try e.line(stmt.span, "{s}: ;", .{fin});
    try e.emitStatement(.{ .block = finally_block });
    if (e.labelUsed(fin_thr)) {
        try e.line(stmt.span, "if (jsrt_number_value({s}) == 1) {{ jsrt_throw({s}); goto {s}; }}", .{ comp, exc, try e.currentPad() });
    }
    try emitFinallyDispatch(e, scope, comp, stmt.span);
    try e.closeBlock(stmt.span);
}

pub fn emitCatchEntry(e: *Emitter, stmt: *const nodes.TryStatement) Error!void {
    if (stmt.catch_binding) |binding| {
        try e.line(stmt.span, "{s} = jsrt_take_exception();", .{try e.slotRef(binding)});
    } else {
        try e.appendLine("(void)jsrt_take_exception();", stmt.span);
    }
}

/// C requires integer constant cases; JS compares with strict equality against arbitrary
/// expressions and tries `default` last wherever it appears, so this is a test chain plus gotos.
pub fn emitSwitch(e: *Emitter, stmt: *const nodes.SwitchStatement) Error!void {
    const id = e.loop_count;
    e.loop_count += 1;
    // Breakable but not continuable: `continue` belongs to the enclosing loop.
    try e.enclosing.append(e.arena, .{ .id = id, .is_loop = false, .label = stmt.label });

    const slot = try e.slotOf(&e.switch_slots, stmt, "switch has no discriminant slot; countBindings missed a node");
    const disc = try e.slotAt(slot);
    try e.line(stmt.span, "{s} = {s};", .{ disc, try e.emitExpression(stmt.discriminant) });

    // One block scope, so every clause's declarations hoist together ahead of the dispatch.
    for (stmt.clauses) |clause| try e.emitHoistedFunctions(clause.statements);

    var default_index: ?usize = null;
    for (stmt.clauses, 0..) |clause, i| {
        const clause_test = clause.@"test" orelse {
            default_index = i;
            continue;
        };
        const test_text = try e.emitExpression(clause_test);
        try e.line(stmt.span, "if (jsrt_strict_equals({s}, {s})) goto case_{d}_{d};", .{ disc, test_text, id, i });
    }

    if (default_index) |index| {
        try e.line(stmt.span, "goto case_{d}_{d};", .{ id, index });
    } else {
        try e.useLabel(try e.fmt("brk_{d}", .{id}));
        try e.line(stmt.span, "goto brk_{d};", .{id});
    }

    for (stmt.clauses, 0..) |clause, i| {
        try e.line(stmt.span, "case_{d}_{d}: ;", .{ id, i });
        e.indent += 1;
        for (clause.statements) |s| try e.emitStatement(s);
        e.indent -= 1;
    }

    try e.emitJumpTarget(try e.fmt("brk_{d}", .{id}), stmt.span);
    _ = e.enclosing.pop();
}

test "a bare slot is a slot and nothing else" {
    try std.testing.expect(isBareSlot("JSRT_LOCAL(3)"));
    try std.testing.expect(isBareSlot("JSRT_GLOBAL(12)"));
    try std.testing.expect(isBareSlot("_jsrt_env->slots[0]"));
    try std.testing.expect(!isBareSlot("JSRT_LOCAL()"));
    try std.testing.expect(!isBareSlot("JSRT_LOCAL(3) "));
    try std.testing.expect(!isBareSlot("JSRT_ENV_AT(env, 0, 1)"));
    try std.testing.expect(!isBareSlot("jsrt_call(JSRT_LOCAL(3))"));
}
