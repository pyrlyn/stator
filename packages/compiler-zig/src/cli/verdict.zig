//! What `stator explain` reads off a compiled program: static or dynamic, its functions, and its
//! extern calls. `packages/compiler/src/cli/explain.ts` keeps the reasoning per kind.
const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("../hir/nodes.zig");
const hir_types = @import("../hir/types.zig");
const rewrite = @import("../passes/rewrite.zig");
const failure = @import("failure.zig");
const oom = failure.oom;

const Block = nodes.Block;
const Expression = nodes.Expression;
const FunctionExpr = nodes.FunctionExpr;
const Module = nodes.Module;
const Statement = nodes.Statement;
const hasUnknownType = hir_types.hTypeHasUnknown;

pub const FunctionReport = struct {
    name: []const u8,
    line: u32,
    provenance: nodes.Provenance,
    verdict: enum { static, dynamic },
};

pub const ExternCallReport = struct { name: []const u8, line: u32 };

const Names = std.StringHashMapUnmanaged(void);

/// Slot-bound names: an out-slot reads `unknown` without touching the dynamic representation, and
/// names are unique program-wide, so no scope threading is owed. Aliases inside function bodies
/// stay out and read dynamic, as the gate proves legality and this only colors a verdict.
const Walk = struct {
    a: Allocator,
    out_slots: Names = .empty,

    fn isOutSlot(w: *const Walk, value: Expression) bool {
        return switch (value) {
            .out_new => true,
            .identifier => |x| w.out_slots.contains(x.name),
            else => false,
        };
    }

    fn consider(w: *Walk, name: []const u8, value: ?Expression) void {
        const v = value orelse return;
        if (w.isOutSlot(v)) w.out_slots.put(w.a, name, {}) catch oom();
    }

    fn collectBlock(w: *Walk, body: ?*const Block) void {
        if (body) |b| w.collect(b.statements);
    }

    fn collect(w: *Walk, list: []const Statement) void {
        for (list) |stmt| switch (stmt) {
            .declaration => |x| w.consider(x.name, x.value),
            .assignment => |x| w.consider(x.target, x.value),
            .block => |x| w.collect(x.statements),
            .if_statement => |x| {
                w.collectBlock(x.consequent);
                w.collectBlock(x.alternate);
            },
            .while_statement => |x| w.collectBlock(x.body),
            .do_while_statement => |x| w.collectBlock(x.body),
            .for_of_statement => |x| w.collectBlock(x.body),
            .for_statement => |x| {
                if (x.init) |s| w.collect(&.{s});
                if (x.update) |s| w.collect(&.{s});
                w.collectBlock(x.body);
            },
            .switch_statement => |x| for (x.clauses) |c| w.collect(c.statements),
            .try_statement => |x| {
                w.collectBlock(x.try_block);
                w.collectBlock(x.catch_block);
                w.collectBlock(x.finally_block);
            },
            else => {},
        };
    }

    fn isOutSlotBinding(w: *const Walk, stmt: Statement) bool {
        if (stmt != .declaration) return false;
        const value = stmt.declaration.value orelse return false;
        return w.isOutSlot(value);
    }

    /// A statement or an expression.
    fn one(w: *const Walk, node: anytype) bool {
        return if (@TypeOf(node) == Statement) w.statement(node) else w.expression(node);
    }

    fn any(w: *const Walk, list: anytype) bool {
        for (list) |node| if (w.one(node)) return true;
        return false;
    }

    fn opt(w: *const Walk, node: anytype) bool {
        return if (node) |v| w.one(v) else false;
    }

    fn block(w: *const Walk, b: ?*const Block) bool {
        return if (b) |v| w.any(v.statements) else false;
    }

    fn statement(w: *const Walk, stmt: Statement) bool {
        if (stmt.getType().* == .unknown and !w.isOutSlotBinding(stmt)) return true;
        return switch (stmt) {
            .declaration => |x| w.opt(x.value),
            .assignment => |x| w.expression(x.value),
            .expression_statement => |x| w.expression(x.expression),
            .if_statement => |x| w.expression(x.condition) or w.block(x.consequent) or w.block(x.alternate),
            inline .while_statement, .do_while_statement => |x| w.expression(x.condition) or w.block(x.body),
            .for_statement => |x| w.opt(x.init) or w.opt(x.condition) or w.opt(x.update) or w.block(x.body),
            .switch_statement => |x| blk: {
                if (w.expression(x.discriminant)) break :blk true;
                for (x.clauses) |c| {
                    if (w.opt(c.@"test") or w.any(c.statements)) break :blk true;
                }
                break :blk false;
            },
            .break_statement, .continue_statement => false,
            .block => |x| w.any(x.statements),
            .function_declaration => |x| w.function(x.@"fn"),
            .return_statement => |x| w.opt(x.value),
            .index_assignment => |x| w.expression(x.target) or w.expression(x.index) or w.expression(x.value),
            // The loop binding is the iterable's element type, which the deep check on the iterable
            // already covers.
            .for_of_statement => |x| w.expression(x.iterable) or w.block(x.body),
            .field_assignment => |x| w.expression(x.target) or w.expression(x.value),
            .dyn_field_assignment => true,
            .class_declaration => |x| blk: {
                for (x.fields) |f| if (hasUnknownType(f.type)) break :blk true;
                if (x.ctor) |c| if (w.function(c.@"fn")) break :blk true;
                for (x.methods) |m| if (w.function(m.@"fn")) break :blk true;
                break :blk false;
            },
            .super_call => |x| w.expression(x.receiver) or w.any(x.args),
            .throw_statement => |x| w.expression(x.value),
            // Anything can be thrown, so the catch binding is always Unknown and says nothing: only
            // the blocks' contents count.
            .try_statement => |x| w.block(x.try_block) or w.block(x.catch_block) or w.block(x.finally_block),
        };
    }

    fn function(w: *const Walk, f: *const FunctionExpr) bool {
        if (hasUnknownType(f.type)) return true;
        return w.functionBody(f);
    }

    fn functionBody(w: *const Walk, f: *const FunctionExpr) bool {
        for (f.params) |p| if (p.type.* == .unknown) return true;
        return w.statement(.{ .block = f.body });
    }

    fn expression(w: *const Walk, expr: Expression) bool {
        // A pointer crosses as opaque bits, so an extern call is static unless a checkable argument
        // is dynamic. The kind decides because every handle reads `unknown`.
        switch (expr) {
            .extern_call => |x| {
                for (x.args, x.arg_kinds) |arg, kind| {
                    if (kind == .pointer or kind == .@"out-pointer") continue;
                    if (arg == .boundary_check or w.expression(arg)) return true;
                }
                return false;
            },
            .out_new, .out_get => return false,
            .identifier => |x| if (w.out_slots.contains(x.name)) return false,
            else => {},
        }
        if (hasUnknownType(expr.getType())) return true;
        return switch (expr) {
            .number_literal, .string_literal, .boolean_literal, .null_literal, .undefined_literal, .identifier, .reference_error, .type_error => false,
            inline .binary_op, .logical_op => |x| w.expression(x.left) or w.expression(x.right),
            inline .unary_op, .string_length, .array_length, .function_length => |x| w.expression(x.operand),
            .conditional => |x| w.expression(x.condition) or w.expression(x.consequent) or w.expression(x.alternate),
            .optional_chain => |x| w.expression(x.base) or w.expression(x.consequent),
            .optional_base => false,
            .update => |x| w.place(x.target) or w.opt(x.value),
            .array_literal => |x| w.any(x.elements),
            .index_access => |x| w.expression(x.target) or w.expression(x.index),
            .template_literal => |x| w.any(x.expressions),
            inline .console_log, .new, .regexp_op, .math_call, .date_components, .date_static, .global_call, .object_static, .typed_op, .string_static => |x| w.any(x.args),
            .function => |x| w.functionBody(x),
            .call => |x| w.expression(x.callee) or w.any(x.args),
            inline .new_value, .method_call, .field_call, .collection_op, .array_op, .date_op, .number_op, .string_op, .promise_method => |x| w.expression(x.target) or w.any(x.args),
            .class_value => false,
            inline .field_access, .method_value, .regexp_read, .instanceof, .accessor_place, .get_iterator => |x| w.expression(x.target),
            // `exec` answers a match or null, so the receiver cannot be typed, yet the read is one
            // fixed runtime call. `groups` reads Unknown and was answered above.
            .match_read => false,
            .dyn_method_call => true,
            .instanceof_value => |x| w.expression(x.target) or w.expression(x.ctor),
            .object_literal => |x| blk: {
                for (x.entries) |e| if (w.expression(e.value)) break :blk true;
                for (x.method_copies) |c| if (w.expression(.{ .method_value = c.value })) break :blk true;
                break :blk false;
            },
            .dyn_object_literal, .dyn_field_access, .json_parse => true,
            .collection_new => false,
            .regexp_literal => false,
            .iterator_next => |x| w.expression(x.target) or w.expression(x.sent),
            inline .date_new, .error_new, .json_stringify, .promise_static => |x| w.expression(x.arg),
            inline .await, .yield => |x| w.expression(x.value),
            .promise_construct => |x| w.expression(x.executor),
            .typeof => false,
            .delete_prop => true,
            // A check is where an Unknown becomes concrete, so it reports the type it produced.
            .boundary_check => false,
            .extern_call, .out_new, .out_get => unreachable,
        };
    }

    fn place(w: *const Walk, target: nodes.UpdatePlace) bool {
        return w.expression(target.expression());
    }
};

/// One Unknown anywhere makes the whole file dynamic: the function rows see signatures only, so a
/// file of `static` rows can still be dynamic.
pub fn hasUnknown(a: Allocator, module: *const Module) bool {
    var w: Walk = .{ .a = a };
    while (true) {
        const before = w.out_slots.count();
        w.collect(module.statements);
        if (w.out_slots.count() == before) break;
    }
    return w.any(module.statements);
}

const Found = struct {
    a: Allocator,
    functions: std.ArrayList(*const FunctionExpr) = .empty,
    externs: std.ArrayList(*const nodes.ExternCall) = .empty,

    fn onExpression(context: ?*anyopaque, expr: Expression) rewrite.Error!Expression {
        const f: *Found = @ptrCast(@alignCast(context.?));
        switch (expr) {
            .function => |x| f.functions.append(f.a, x) catch oom(),
            .extern_call => |x| f.externs.append(f.a, x) catch oom(),
            else => {},
        }
        return expr;
    }

    fn onStatement(context: ?*anyopaque, stmt: Statement) rewrite.Error!?Statement {
        const f: *Found = @ptrCast(@alignCast(context.?));
        switch (stmt) {
            .function_declaration => |x| f.functions.append(f.a, x.@"fn") catch oom(),
            .class_declaration => |x| {
                if (x.ctor) |c| f.functions.append(f.a, c.@"fn") catch oom();
                for (x.methods) |m| f.functions.append(f.a, m.@"fn") catch oom();
            },
            else => {},
        }
        return stmt;
    }
};

fn byLine(comptime Report: type) fn (void, Report, Report) bool {
    return struct {
        fn less(_: void, l: Report, r: Report) bool {
            return l.line < r.line;
        }
    }.less;
}

pub const Reports = struct {
    functions: []const FunctionReport,
    extern_calls: []const ExternCallReport,
};

/// Through the one HIR walker, so a kind added there keeps being reported. A declaration's function
/// is rewritten directly rather than as an expression, which is why both hooks are needed and why
/// neither reports it twice. `error` is a tree past the nesting limit; the verifier names it.
pub fn reports(a: Allocator, module: *const Module) rewrite.Error!Reports {
    var found: Found = .{ .a = a };
    _ = try rewrite.rewriteModule(module, .{ .arena = a, .context = &found, .expression = Found.onExpression, .statement = Found.onStatement });
    const functions = a.alloc(FunctionReport, found.functions.items.len) catch oom();
    for (found.functions.items, functions) |f, *out| out.* = .{
        .name = f.name orelse "<anonymous>",
        .line = f.span.line,
        .provenance = f.provenance,
        .verdict = if (f.provenance == .dynamic) .dynamic else .static,
    };
    std.mem.sort(FunctionReport, functions, {}, byLine(FunctionReport));
    const externs = a.alloc(ExternCallReport, found.externs.items.len) catch oom();
    for (found.externs.items, externs) |x, *out| out.* = .{ .name = x.c_name, .line = x.span.line };
    std.mem.sort(ExternCallReport, externs, {}, byLine(ExternCallReport));
    return .{ .functions = functions, .extern_calls = externs };
}
