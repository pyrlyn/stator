//! Frame-slot assignment and C storage names. Mirrors `packages/compiler/src/codegen/slots.ts`,
//! which keeps why each construct claims the slots it does. Every slot must be final before the
//! first line of a body exists because `JSRT_FRAME(n)` is written once at the top.

const std = @import("std");
const nodes = @import("../hir/nodes.zig");
const emitter = @import("emitter.zig");
const helpers = @import("helpers.zig");
const literals = @import("literals.zig");

const Emitter = emitter.Emitter;
const Error = emitter.Error;
const Parts = emitter.Parts;
const StringSet = emitter.StringSet;
const Expression = nodes.Expression;
const Statement = nodes.Statement;
const Span = nodes.Span;

pub fn bindSlot(e: *Emitter, name: []const u8) Error!void {
    if (e.env_map.contains(name) or e.slot_map.contains(name)) return;
    // A top-level name already lives in the globals array; the async module body must not grow a
    // second home for it in the heap environment.
    if (e.module_async and e.global_map.contains(name)) return;
    try e.slot_map.put(e.arena, name, e.slot_count);
    e.slot_count += 1;
}

fn claimSlots(e: *Emitter, map: *emitter.SlotIds, key: *const anyopaque, count: usize) Error!void {
    try map.put(e.arena, key, e.slot_count);
    e.slot_count += count;
}

fn claimThenCount(e: *Emitter, map: *emitter.SlotIds, key: *const anyopaque, count: usize, operands: []const Expression) Error!void {
    try claimSlots(e, map, key, count);
    for (operands) |operand| try e.countExpression(operand);
}

pub fn countBindings(e: *Emitter, statements: []const Statement) Error!void {
    for (statements) |stmt| {
        switch (stmt) {
            .declaration => |s| {
                try e.bindSlot(s.name);
                if (s.value) |value| {
                    if (value == .function) {
                        _ = try e.registerFunction(value.function, value.function.name orelse s.name);
                    } else {
                        try e.countExpression(value);
                    }
                }
            },
            .assignment => |s| try e.countExpression(s.value),
            .expression_statement => |s| try e.countExpression(s.expression),
            .block => |s| try e.countBindings(s.statements),
            .if_statement => |s| {
                try e.countExpression(s.condition);
                try e.countBindings(s.consequent.statements);
                if (s.alternate) |alternate| try e.countBindings(alternate.statements);
            },
            inline .while_statement, .do_while_statement => |s| {
                try e.countIterEnvSlots(stmt, s.per_iteration_env);
                try e.countExpression(s.condition);
                try e.countBindings(s.body.statements);
            },
            .for_statement => |s| {
                try e.countIterEnvSlots(stmt, s.per_iteration_env);
                if (s.init) |init_statement| try e.countBindings(&.{init_statement});
                if (s.condition) |condition| try e.countExpression(condition);
                if (s.update) |update| try e.countBindings(&.{update});
                try e.countBindings(s.body.statements);
            },
            .switch_statement => |s| {
                try claimSlots(e, &e.switch_slots, s, 1);
                try e.countExpression(s.discriminant);
                for (s.clauses) |clause| {
                    if (clause.@"test") |clause_test| try e.countExpression(clause_test);
                    try e.countBindings(clause.statements);
                }
            },
            .function_declaration => |s| {
                try e.bindSlot(s.name);
                _ = try e.registerFunction(s.@"fn", s.@"fn".name orelse s.name);
            },
            .return_statement => |s| {
                if (s.value) |value| {
                    e.returns_value = true;
                    try e.countExpression(value);
                }
            },
            .index_assignment => |s| try claimThenCount(e, &e.index_slots, s, 3, &.{ s.target, s.index, s.value }),
            .for_of_statement => |s| {
                try e.countIterEnvSlots(stmt, s.per_iteration_env);
                try claimSlots(e, &e.for_of_slots, s, 1);
                if (e.forOfIsBoxed(s)) try claimSlots(e, &e.for_of_close_slots, s, 3);
                try e.countExpression(s.iterable);
                try e.bindSlot(s.binding);
                try e.countBindings(s.body.statements);
            },
            inline .field_assignment, .dyn_field_assignment => |s| try claimThenCount(e, &e.index_slots, s, 2, &.{ s.target, s.value }),
            .super_call => |s| {
                // Partial on purpose: a base the collection has not seen yet keeps no reservation
                // for a call that never happens, and a base with a constructor keeps today's.
                for (e.classes.items) |class| {
                    if (!std.mem.eql(u8, class.name, s.class_name)) continue;
                    if (class.ctor != null) {
                        try claimSlots(e, &e.call_slots, s, 1 + s.args.len);
                        try e.countExpression(s.receiver);
                        for (s.args) |arg| try e.countExpression(arg);
                    }
                    break;
                }
            },
            .class_declaration => |s| {
                if (!e.class_ids.contains(s.name)) {
                    try e.class_ids.put(e.arena, s.name, e.classes.items.len);
                    try e.classes.append(e.arena, s);
                }
                if (s.ctor) |ctor| _ = try e.registerFunction(ctor.@"fn", s.name);
                for (s.methods) |method| _ = try e.registerFunction(method.@"fn", method.name);
                for (s.statics) |decl| try e.countBindings(&.{.{ .declaration = decl }});
            },
            .break_statement, .continue_statement => {},
            .throw_statement => |s| try e.countExpression(s.value),
            .try_statement => |s| {
                if (s.catch_binding) |binding| try e.bindSlot(binding);
                if (s.finally_block != null) try claimSlots(e, &e.try_slots, s, 2);
                try e.countBindings(s.try_block.statements);
                if (s.catch_block) |catch_block| try e.countBindings(catch_block.statements);
                if (s.finally_block) |finally_block| try e.countBindings(finally_block.statements);
            },
        }
    }
}

/// The rooted slot holding a spread fragment's source, evaluating it once on first use. A null
/// slot means the fragment keeps no scratch: an identifier source stays inline.
pub fn spreadSource(e: *Emitter, parts: *Parts, key: []const u8, state: *emitter.SpreadState, span: Span, flushed: bool) Error!emitter.SpreadRead {
    const scratch = state.at.get(key) orelse return .{ .slot = null, .flushed = flushed };
    const source = state.target.get(key) orelse return .{ .slot = null, .flushed = flushed };
    var next = flushed;
    if (!state.done.contains(key)) {
        try state.done.put(e.arena, key, {});
        next = (try e.sequenceAssign(parts, source, span, scratch)) or next;
    }
    return .{ .slot = try e.slotAt(scratch), .flushed = next };
}

fn spreadKeyOf(e: *Emitter, value: Expression) Error!?[]const u8 {
    const span, const target = switch (value) {
        .field_access => |x| .{ x.span, x.target },
        .method_value => |x| .{ x.span, x.target },
        else => return null,
    };
    if (target == .identifier) return null;
    return try helpers.spreadScratchKey(e.arena, span);
}

/// A spread's reads share one source subtree, which emission evaluates once into a scratch: the
/// first read counts it and the rest count nothing.
pub fn countEntryValue(e: *Emitter, value: Expression, spread_keys: *const StringSet, counted_spread: *StringSet) Error!void {
    if (try spreadKeyOf(e, value)) |key| {
        if (spread_keys.contains(key)) {
            if (!counted_spread.contains(key)) {
                try counted_spread.put(e.arena, key, {});
                try e.countExpression(value);
            }
            return;
        }
    }
    try e.countExpression(value);
}

/// One contiguous run of rooted slots: the leading operand, when there is one, then each argument.
pub fn countRooted(e: *Emitter, expr: *const anyopaque, lead: ?Expression, args: []const Expression) Error!void {
    try claimSlots(e, &e.call_slots, expr, @as(usize, if (lead == null) 0 else 1) + args.len);
    if (lead) |operand| try e.countExpression(operand);
    for (args) |arg| try e.countExpression(arg);
}

fn spreadKeySet(e: *Emitter, scratches: []const helpers.SpreadGroup) Error!StringSet {
    var keys: StringSet = .empty;
    for (scratches) |scratch| try keys.put(e.arena, scratch.key, {});
    return keys;
}

pub fn countExpression(e: *Emitter, expr: Expression) Error!void {
    switch (expr) {
        .logical_op => |x| try claimThenCount(e, &e.temp_slots, x, 1, &.{ x.left, x.right }),
        .binary_op => |x| try claimThenCount(e, &e.binary_slots, x, 2, &.{ x.left, x.right }),
        .unary_op => |x| {
            if (helpers.unaryConverts(x)) try claimSlots(e, &e.temp_slots, x, 1);
            try e.countExpression(x.operand);
        },
        inline .typeof, .string_length, .function_length, .out_get => |x| try e.countExpression(x.operand),
        .array_length => |x| try claimThenCount(e, &e.temp_slots, x, 1, &.{x.operand}),
        .conditional => |x| try claimThenCount(e, &e.temp_slots, x, 1, &.{ x.condition, x.consequent, x.alternate }),
        .optional_chain => |x| try claimThenCount(e, &e.temp_slots, x, 1, &.{ x.base, x.consequent }),
        .optional_base => {},
        .update => |x| {
            try claimSlots(e, &e.temp_slots, x, 1);
            // The right operand of a numeric compound assignment waits in the slot after the
            // result while the left one's `valueOf` runs.
            if (helpers.compoundConverts(x)) e.slot_count += 1;
            switch (x.target) {
                .index_access => |place| try claimThenCount(e, &e.index_slots, x, 2, &.{ place.target, place.index }),
                .accessor_place => |place| try claimThenCount(e, &e.index_slots, x, 2, &.{place.target}),
                inline .field_access, .dyn_field_access => |place| try claimThenCount(e, &e.index_slots, x, 1, &.{place.target}),
                .identifier => {},
            }
            if (x.value) |value| try e.countExpression(value);
        },
        .boundary_check => |x| try e.countExpression(x.value),
        .array_literal => |x| {
            try claimSlots(e, &e.array_slots, x, x.elements.len);
            for (x.elements) |element| try e.countExpression(element);
        },
        .index_access => |x| try claimThenCount(e, &e.index_slots, x, 2, &.{ x.target, x.index }),
        .delete_prop => |x| try claimThenCount(e, &e.index_slots, x, 2, &.{ x.target, x.key }),
        .template_literal => |x| {
            var count = x.expressions.len;
            for (x.quasis) |quasi| {
                if (quasi.len != 0) count += 1;
            }
            if (count == 0) return e.fail("template literal has no parts; verifier should have caught it", .{});
            try e.template_slots.put(e.arena, x, .{ .base = e.slot_count, .count = count });
            e.slot_count += count;
            for (x.expressions) |part| try e.countExpression(part);
        },
        .console_log => |x| {
            if (x.args.len >= 2) try claimSlots(e, &e.call_slots, x, x.args.len);
            for (x.args) |arg| try e.countExpression(arg);
        },
        .function => |x| _ = try e.registerFunction(x, x.name orelse ""),
        .call => |x| try e.countRooted(x, x.callee, x.args),
        .extern_call => |x| {
            const result_slots: usize = if (x.ret_kind == .void) 0 else 1;
            try claimSlots(e, &e.call_slots, x, result_slots + x.args.len);
            for (x.args) |arg| try e.countExpression(arg);
            try e.recordExternDecl(x);
        },
        .new => |x| {
            try claimSlots(e, &e.call_slots, x, 1 + x.args.len);
            for (x.args) |arg| try e.countExpression(arg);
        },
        inline .method_call, .new_value, .promise_method, .array_op, .collection_op, .date_op, .number_op, .regexp_op, .string_op => |x| try e.countRooted(x, x.target, x.args),
        inline .dyn_method_call, .field_call => |x| {
            try claimSlots(e, &e.call_slots, x, 2 + x.args.len);
            try e.countExpression(x.target);
            for (x.args) |arg| try e.countExpression(arg);
        },
        .object_literal => |x| {
            const scratches = try helpers.spreadScratches(e.arena, x.entries, x.method_copies);
            const snaps = try helpers.spreadSnapshots(e.arena, x.entries);
            try claimSlots(e, &e.call_slots, x, 1 + scratches.len + snaps.len);
            try e.registerShape(x);
            const spread_keys = try spreadKeySet(e, scratches);
            var counted_spread: StringSet = .empty;
            for (x.entries) |entry| try e.countEntryValue(entry.value, &spread_keys, &counted_spread);
            for (x.method_copies) |copy| {
                try e.countEntryValue(.{ .method_value = copy.value }, &spread_keys, &counted_spread);
            }
            for (x.methods) |method| _ = try e.registerFunction(method.@"fn", method.name);
        },
        .dyn_object_literal => |x| {
            const scratches = try helpers.spreadScratches(e.arena, x.entries, &.{});
            try claimSlots(e, &e.call_slots, x, helpers.dynLiteralBaseSlots(x) + scratches.len);
            const spread_keys = try spreadKeySet(e, scratches);
            var counted_spread: StringSet = .empty;
            for (x.entries) |entry| {
                switch (entry) {
                    .accessor_entry => |accessor| {
                        if (accessor.get) |get| try e.countExpression(get);
                        if (accessor.set) |set| try e.countExpression(set);
                    },
                    .computed_entry => |computed| {
                        try e.countExpression(computed.key);
                        try e.countExpression(computed.value);
                    },
                    .object_entry => |object| try e.countEntryValue(object.value, &spread_keys, &counted_spread),
                }
            }
        },
        inline .date_new, .error_new, .json_parse, .json_stringify, .promise_static => |x| try countOne(e, x, x.arg),
        inline .await, .yield => |x| try countSuspend(e, x, x.value),
        .promise_construct => |x| try countOne(e, x, x.executor),
        inline .date_components, .date_static, .global_call, .object_static, .typed_op => |x| try e.countRooted(x, null, x.args),
        .iterator_next => |x| try claimThenCount(e, &e.call_slots, x, 2, &.{ x.target, x.sent }),
        inline .math_call, .string_static => |x| try countSequenced(e, x, x.args),
        inline .field_access, .method_value, .match_read, .regexp_read, .instanceof, .accessor_place => |x| try e.countExpression(x.target),
        .instanceof_value => |x| try e.countRooted(x, x.target, &.{x.ctor}),
        .class_value => {},
        inline .dyn_field_access, .get_iterator => |x| try claimThenCount(e, &e.temp_slots, x, 1, &.{x.target}),
        .regexp_literal => |x| try claimSlots(e, &e.call_slots, x, 1),
        .collection_new,
        .number_literal,
        .string_literal,
        .boolean_literal,
        .null_literal,
        .undefined_literal,
        .identifier,
        .reference_error,
        .type_error,
        .out_new,
        => {},
    }
}

fn countOne(e: *Emitter, expr: *const anyopaque, operand: Expression) Error!void {
    try claimSlots(e, &e.call_slots, expr, 1);
    try e.countExpression(operand);
}

/// The state number is assigned while counting because the dispatch switch is emitted ahead of the
/// labels it jumps to. A shared node is renumbered, keeping its first place in the order.
fn countSuspend(e: *Emitter, expr: *const anyopaque, value: Expression) Error!void {
    try claimSlots(e, &e.temp_slots, expr, 1);
    try e.await_states.put(e.arena, expr, e.await_states.count() + 1);
    try e.countExpression(value);
}

/// A single immediate has no order to fix and takes no slot, unless it may be an object whose
/// `valueOf` can throw, which makes the call a statement with a pending check.
fn countSequenced(e: *Emitter, expr: *const anyopaque, args: []const Expression) Error!void {
    if (args.len > 1 or helpers.argsConvert(args)) try claimSlots(e, &e.call_slots, expr, args.len);
    for (args) |arg| try e.countExpression(arg);
}

pub fn countIterEnvSlots(e: *Emitter, stmt: Statement, per_iteration_env: ?bool) Error!void {
    if (per_iteration_env != true or e.env_map.count() == 0) return;
    try claimSlots(e, &e.iter_env_slots, stmt.id(), 2);
}

pub fn slotAt(e: *Emitter, slot: usize) Error![]const u8 {
    // An async or generator unit keeps every local in its heap environment: its frame is popped at
    // each suspension.
    if (e.in_async or e.in_generator) return e.fmt("_jsrt_env->slots[{d}]", .{slot});
    return if (e.in_function) e.fmt("JSRT_LOCAL({d})", .{slot}) else e.fmt("JSRT_GLOBAL({d})", .{slot});
}

/// The environment cases come first: a captured binding was deliberately kept out of the frame, so
/// a frame slot of the same name would be a silently divergent copy.
pub fn slotRef(e: *Emitter, name: []const u8) Error![]const u8 {
    if (e.env_map.get(name)) |owned| return e.fmt("_jsrt_env->slots[{d}]", .{owned});
    if (e.capture_map.get(name)) |captured| {
        return e.fmt("JSRT_ENV_AT(env, {d}, {d})", .{ captured.levels, captured.index });
    }
    if (e.slot_map.get(name)) |own| return e.slotAt(own);
    const global = e.global_map.get(name) orelse return e.fail("Undefined identifier: {s}", .{name});
    return e.fmt("JSRT_GLOBAL({d})", .{global});
}

pub fn appendLine(e: *Emitter, line: []const u8, span: ?Span) Error!void {
    var full: std.ArrayList(u8) = .empty;
    if (span) |at| {
        if (line.len != 0 and line[0] != '}') {
            const file = try literals.escapeCString(e.arena, at.file orelse e.file_name);
            try full.print(e.arena, "#line {d} \"{s}\"\n", .{ at.line, file });
        }
    }
    try full.appendNTimes(e.arena, ' ', e.indent * 2);
    try full.appendSlice(e.arena, line);
    try e.lines.append(e.arena, full.items);
}
