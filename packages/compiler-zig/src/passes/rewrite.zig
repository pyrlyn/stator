//! The one HIR walker: every pass in this directory rebuilds the tree through it.
//! `packages/compiler/src/passes/rewrite.ts` keeps the reasoning.
//!
//! The switches name every kind on purpose. A reflective walker would handle a future kind
//! silently, and a node with special evaluation rules would be rewritten by a pass that never
//! decided it was safe to.
//!
//! Rewriting is bottom-up, and a node comes back as the same pointer when nothing under it changed:
//! a caller tells "nothing happened" from identity alone.

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("../hir/nodes.zig");
const MAX_NESTING = @import("../hir/verify.zig").MAX_NESTING;
const Block = nodes.Block;
const ClassMethod = nodes.ClassMethod;
const Declaration = nodes.Declaration;
const DynEntry = nodes.DynEntry;
const Expression = nodes.Expression;
const FunctionExpr = nodes.FunctionExpr;
const MethodCopy = nodes.MethodCopy;
const Module = nodes.Module;
const ObjectEntry = nodes.ObjectEntry;
const Parameter = nodes.Parameter;
const Statement = nodes.Statement;
const SwitchClause = nodes.SwitchClause;
const UpdatePlace = nodes.UpdatePlace;

/// What a rewrite refuses. The three shapes it cannot keep are pass bugs, and both ways of carrying
/// on are silent: a dropped for-update loops forever, and a spliced one does not parse as C.
pub const Error = Allocator.Error || error{
    /// Past `MAX_NESTING`. Not a pass bug: this is the source, and going on overflows the stack.
    NestedTooDeeply,
    /// A for header holds exactly one init and one update.
    ForHeaderStatementChanged,
    /// `++`/`--`/`=` must keep a place to write to.
    UpdateTargetChanged,
    /// A spread's method copy must stay a method value.
    MethodCopyChanged,
};

/// What a pass supplies; all three see children already rewritten. Returning the argument says
/// "nothing happened". `statement` answers null to delete: the two things a statement pass does
/// are replace and delete, and no pass here splices in more than one. `statements` sees a whole
/// run because a statement alone cannot speak for its following siblings.
pub const Rewriter = struct {
    arena: Allocator,
    context: ?*anyopaque = null,
    expression: ?*const fn (context: ?*anyopaque, expr: Expression) Error!Expression = null,
    statement: ?*const fn (context: ?*anyopaque, stmt: Statement) Error!?Statement = null,
    statements: ?*const fn (context: ?*anyopaque, arena: Allocator, list: []const Statement) Error![]const Statement = null,
    depth: u16 = 0,
};

/// A rewriter whose hooks are `T`'s `expression`, `statement` and `statements` methods, each taking
/// `*T` in place of the context pointer. A hook `T` does not declare stays null; the hooks must be
/// `pub`, since a private one is invisible here and would silently go unregistered.
pub fn visiting(comptime T: type, arena: Allocator, self: *T) Rewriter {
    comptime if (!@hasDecl(T, "expression") and !@hasDecl(T, "statement") and !@hasDecl(T, "statements")) {
        @compileError(@typeName(T) ++ " declares no pub rewrite hook");
    };
    const Hooks = struct {
        fn expression(context: ?*anyopaque, expr: Expression) Error!Expression {
            return T.expression(@ptrCast(@alignCast(context)), expr);
        }
        fn statement(context: ?*anyopaque, stmt: Statement) Error!?Statement {
            return T.statement(@ptrCast(@alignCast(context)), stmt);
        }
        fn statements(context: ?*anyopaque, a: Allocator, list: []const Statement) Error![]const Statement {
            return T.statements(@ptrCast(@alignCast(context)), a, list);
        }
    };
    return .{
        .arena = arena,
        .context = self,
        .expression = if (@hasDecl(T, "expression")) Hooks.expression else null,
        .statement = if (@hasDecl(T, "statement")) Hooks.statement else null,
        .statements = if (@hasDecl(T, "statements")) Hooks.statements else null,
    };
}

/// A hook's own walk starts again from zero, so the stack is bounded by twice the limit: a walk of
/// a subtree, started at most `MAX_NESTING` down.
fn nested(r: Rewriter) Error!Rewriter {
    if (r.depth >= MAX_NESTING) return error.NestedTooDeeply;
    var inner = r;
    inner.depth += 1;
    return inner;
}

/// Whether two expressions, or two statements, are the same node.
pub fn same(a: anytype, b: @TypeOf(a)) bool {
    return a.id() == b.id();
}

fn sameOptional(a: anytype, b: @TypeOf(a)) bool {
    const x = a orelse return b == null;
    const y = b orelse return false;
    return same(x, y);
}

fn sameList(comptime T: type, a: []const T, b: []const T) bool {
    return a.ptr == b.ptr and a.len == b.len;
}

/// A node with `changes` applied over a copy of `node`.
fn with(arena: Allocator, node: anytype, changes: anytype) Allocator.Error!@TypeOf(node) {
    const Node = @typeInfo(@TypeOf(node)).pointer.child;
    const copy = try arena.create(Node);
    copy.* = node.*;
    inline for (@typeInfo(@TypeOf(changes)).@"struct".field_names) |name| {
        @field(copy, name) = @field(changes, name);
    }
    return copy;
}

/// What a walk descends into: the types `rewriteField` answers for.
const WALKED_TYPES = [_]type{
    Expression,
    ?Expression,
    []const Expression,
    ?Statement,
    []const Statement,
    *const Block,
    ?*const Block,
    *const FunctionExpr,
    []const Parameter,
    ?ClassMethod,
    []const ClassMethod,
    []const *const Declaration,
    []const SwitchClause,
    []const ObjectEntry,
    []const MethodCopy,
    []const DynEntry,
};

fn walked(comptime T: type) bool {
    for (WALKED_TYPES) |candidate| {
        if (candidate == T) return true;
    }
    return false;
}

/// A subtree left out of a walk is one no pass ever sees, and no output shows it until a fold or a
/// call lands there, so leaving one out is a compile error rather than a test to remember.
fn assertWalksAll(comptime Node: type, comptime fields: anytype) void {
    field: for (@typeInfo(Node).@"struct".field_names) |name| {
        if (!walked(@FieldType(Node, name))) continue;
        // A class's `fields` are its layout, and the lowering already put the initializers in `ctor`.
        if (Node == nodes.ClassDeclaration and std.mem.eql(u8, name, "fields")) continue;
        for (fields) |listed| {
            if (std.mem.eql(u8, @tagName(listed), name)) continue :field;
        }
        @compileError(@typeName(Node) ++ "." ++ name ++ " is not walked");
    }
}

/// One field's rewrite, by what the field holds.
fn rewriteField(value: anytype, r: Rewriter) Error!@TypeOf(value) {
    return switch (@TypeOf(value)) {
        Expression => rewriteExpression(value, r),
        ?Expression => rewriteOptional(value, r),
        []const Expression => rewriteArguments(value, r),
        ?Statement => oneStatement(value, r),
        []const Statement => rewriteStatements(value, r),
        *const Block => rewriteBlock(value, r),
        ?*const Block => rewriteOptionalBlock(value, r),
        *const FunctionExpr => rewriteFunction(value, r),
        []const Parameter => rewriteEach(Parameter, value, r, rewriteParameter),
        ?ClassMethod => if (value) |method| (try rewriteMethod(method, r)) orelse value else null,
        []const ClassMethod => rewriteEach(ClassMethod, value, r, rewriteMethod),
        []const *const Declaration => rewriteEach(*const Declaration, value, r, rewriteStatic),
        []const SwitchClause => rewriteEach(SwitchClause, value, r, rewriteClause),
        []const ObjectEntry => rewriteEach(ObjectEntry, value, r, rewriteEntry),
        []const MethodCopy => rewriteEach(MethodCopy, value, r, rewriteMethodCopy),
        []const DynEntry => rewriteEach(DynEntry, value, r, rewriteDynEntry),
        else => @compileError("no rewrite for " ++ @typeName(@TypeOf(value))),
    };
}

fn sameField(a: anytype, b: @TypeOf(a)) bool {
    const T = @TypeOf(a);
    return switch (T) {
        Expression => same(a, b),
        ?Expression => sameOptional(a, b),
        ?Statement => sameOptional(a, b),
        *const Block, ?*const Block, *const FunctionExpr => a == b,
        ?ClassMethod => if (a) |left| b != null and left.@"fn" == b.?.@"fn" else b == null,
        else => sameList(@typeInfo(T).pointer.child, a, b),
    };
}

/// `node` with `fields` rewritten, in that order, or `node` itself when none changed: a walk used
/// as a visitor allocates nothing, and identity is how a caller sees that nothing happened.
fn rewriteFields(node: anytype, comptime fields: anytype, r: Rewriter) Error!@TypeOf(node) {
    comptime assertWalksAll(@typeInfo(@TypeOf(node)).pointer.child, fields);
    var copy = node.*;
    var changed = false;
    inline for (fields) |field| {
        const old = @field(node, @tagName(field));
        const next = try rewriteField(old, r);
        changed = changed or !sameField(next, old);
        @field(copy, @tagName(field)) = next;
    }
    if (!changed) return node;
    const out = try r.arena.create(@TypeOf(copy));
    out.* = copy;
    return out;
}

/// `whole`, the union holding `node`, rebuilt around `fields`.
fn rewriteVariant(whole: anytype, comptime tag: std.meta.Tag(@TypeOf(whole)), node: anytype, comptime fields: anytype, r: Rewriter) Error!@TypeOf(whole) {
    const next = try rewriteFields(node, fields, r);
    return if (next == node) whole else @unionInit(@TypeOf(whole), @tagName(tag), next);
}

pub fn rewriteModule(module: *const Module, r: Rewriter) Error!*const Module {
    return rewriteFields(module, .{.statements}, r);
}

/// The same slice when every statement came back identical and none was deleted.
pub fn rewriteStatements(statements: []const Statement, r: Rewriter) Error![]const Statement {
    var out: ?std.ArrayList(Statement) = null;
    for (statements, 0..) |stmt, index| {
        const replacement = try rewriteStatement(stmt, r);
        const unchanged = if (replacement) |next| same(next, stmt) else false;
        if (out == null and !unchanged) {
            out = .empty;
            try out.?.appendSlice(r.arena, statements[0..index]);
        }
        if (out != null) {
            if (replacement) |next| try out.?.append(r.arena, next);
        }
    }
    const rebuilt: []const Statement = if (out) |list| list.items else statements;
    return if (r.statements) |hook| hook(r.context, r.arena, rebuilt) else rebuilt;
}

fn rewriteBlock(block: *const Block, r: Rewriter) Error!*const Block {
    return rewriteFields(block, .{.statements}, r);
}

fn rewriteOptionalBlock(block: ?*const Block, r: Rewriter) Error!?*const Block {
    return if (block) |b| try rewriteBlock(b, r) else null;
}

fn rewriteOptional(expr: ?Expression, r: Rewriter) Error!?Expression {
    return if (expr) |e| try rewriteExpression(e, r) else null;
}

/// Copies only on the first change, so a walk used as a visitor allocates nothing. `f` answers null
/// for an item it left alone.
fn rewriteEach(
    comptime T: type,
    items: []const T,
    r: Rewriter,
    comptime f: fn (item: T, r: Rewriter) Error!?T,
) Error![]const T {
    var out: ?[]T = null;
    for (items, 0..) |item, index| {
        const next = (try f(item, r)) orelse continue;
        if (out == null) out = try r.arena.dupe(T, items);
        out.?[index] = next;
    }
    return out orelse items;
}

fn rewriteArgument(item: Expression, r: Rewriter) Error!?Expression {
    const next = try rewriteExpression(item, r);
    return if (same(next, item)) null else next;
}

fn rewriteArguments(items: []const Expression, r: Rewriter) Error![]const Expression {
    return rewriteEach(Expression, items, r, rewriteArgument);
}

fn rewriteParameter(param: Parameter, r: Rewriter) Error!?Parameter {
    const default = param.default orelse return null;
    const next = try rewriteExpression(default, r);
    if (same(next, default)) return null;
    var copy = param;
    copy.default = next;
    return copy;
}

pub fn rewriteFunction(function: *const FunctionExpr, r: Rewriter) Error!*const FunctionExpr {
    return rewriteFields(function, .{ .body, .params }, r);
}

/// The method, or null when nothing in it changed.
fn rewriteMethod(method: ClassMethod, r: Rewriter) Error!?ClassMethod {
    const next = try rewriteFunction(method.@"fn", r);
    if (next == method.@"fn") return null;
    return .{ .name = method.name, .@"fn" = next };
}

fn rewriteStatic(static: *const Declaration, r: Rewriter) Error!?*const Declaration {
    const next = try rewriteFields(static, .{.value}, r);
    return if (next == static) null else next;
}

fn rewriteClause(clause: SwitchClause, r: Rewriter) Error!?SwitchClause {
    const test_value = try rewriteOptional(clause.@"test", r);
    const statements = try rewriteStatements(clause.statements, r);
    if (sameOptional(test_value, clause.@"test") and sameList(Statement, statements, clause.statements)) return null;
    return .{ .@"test" = test_value, .statements = statements };
}

/// Null deletes, when the pass's `statement` hook says so.
pub fn rewriteStatement(stmt: Statement, r: Rewriter) Error!?Statement {
    return hooked(?Statement, r.statement, r.context, try rebuildStatement(stmt, try nested(r)));
}

/// The pass sees a node after its children were rewritten.
fn hooked(comptime R: type, hook: anytype, context: ?*anyopaque, rebuilt: anytype) Error!R {
    return if (hook) |h| h(context, rebuilt) else rebuilt;
}

/// A statement in a position that holds exactly one.
fn oneStatement(stmt: ?Statement, r: Rewriter) Error!?Statement {
    const only = stmt orelse return null;
    return (try rewriteStatement(only, r)) orelse error.ForHeaderStatementChanged;
}

fn rebuildStatement(stmt: Statement, r: Rewriter) Error!Statement {
    switch (stmt) {
        inline .declaration, .assignment, .return_statement, .throw_statement => |node, tag| return rewriteVariant(stmt, tag, node, .{.value}, r),
        inline .index_assignment => |node, tag| return rewriteVariant(stmt, tag, node, .{ .target, .index, .value }, r),
        inline .field_assignment, .dyn_field_assignment => |node, tag| return rewriteVariant(stmt, tag, node, .{ .target, .value }, r),
        inline .super_call => |node, tag| return rewriteVariant(stmt, tag, node, .{ .receiver, .args }, r),
        inline .class_declaration => |node, tag| return rewriteVariant(stmt, tag, node, .{ .ctor, .methods, .statics }, r),
        inline .expression_statement => |node, tag| return rewriteVariant(stmt, tag, node, .{.expression}, r),
        inline .if_statement => |node, tag| return rewriteVariant(stmt, tag, node, .{ .condition, .consequent, .alternate }, r),
        inline .while_statement, .do_while_statement => |node, tag| return rewriteVariant(stmt, tag, node, .{ .condition, .body }, r),
        inline .for_statement => |node, tag| return rewriteVariant(stmt, tag, node, .{ .init, .condition, .update, .body }, r),
        inline .for_of_statement => |node, tag| return rewriteVariant(stmt, tag, node, .{ .iterable, .body }, r),
        inline .switch_statement => |node, tag| return rewriteVariant(stmt, tag, node, .{ .discriminant, .clauses }, r),
        inline .function_declaration => |node, tag| return rewriteVariant(stmt, tag, node, .{.@"fn"}, r),
        .block => |node| return .{ .block = try rewriteBlock(node, r) },
        // A jump's only operand is its label, which is a name.
        .break_statement, .continue_statement => return stmt,
        inline .try_statement => |node, tag| return rewriteVariant(stmt, tag, node, .{ .try_block, .catch_block, .finally_block }, r),
    }
}

pub fn rewriteExpression(expr: Expression, r: Rewriter) Error!Expression {
    return hooked(Expression, r.expression, r.context, try rebuildExpression(expr, try nested(r)));
}

fn updatePlace(expr: Expression) Error!UpdatePlace {
    return UpdatePlace.of(expr) orelse error.UpdateTargetChanged;
}

fn rewriteEntry(entry: ObjectEntry, r: Rewriter) Error!?ObjectEntry {
    const value = try rewriteExpression(entry.value, r);
    if (same(value, entry.value)) return null;
    var copy = entry;
    copy.value = value;
    return copy;
}

fn rewriteMethodCopy(entry: MethodCopy, r: Rewriter) Error!?MethodCopy {
    const value = try rewriteExpression(.{ .method_value = entry.value }, r);
    if (value != .method_value) return error.MethodCopyChanged;
    if (value.method_value == entry.value) return null;
    var copy = entry;
    copy.value = value.method_value;
    return copy;
}

fn rewriteDynEntry(entry: DynEntry, r: Rewriter) Error!?DynEntry {
    switch (entry) {
        .accessor_entry => |accessor| {
            const get = try rewriteOptional(accessor.get, r);
            const set = try rewriteOptional(accessor.set, r);
            if (sameOptional(get, accessor.get) and sameOptional(set, accessor.set)) return null;
            return .{ .accessor_entry = .{ .name = accessor.name, .get = get, .set = set } };
        },
        .computed_entry => |computed| {
            const key = try rewriteExpression(computed.key, r);
            const value = try rewriteExpression(computed.value, r);
            if (same(key, computed.key) and same(value, computed.value)) return null;
            return .{ .computed_entry = .{ .key = key, .value = value } };
        },
        .object_entry => |object| {
            const next = (try rewriteEntry(object, r)) orelse return null;
            return .{ .object_entry = next };
        },
    }
}

fn rebuildExpression(expr: Expression, r: Rewriter) Error!Expression {
    switch (expr) {
        // No child expressions: a literal is a value, a regexp carries text, and a reference or
        // type error carries a name because there is no binding to point at.
        inline .regexp_literal, .number_literal, .string_literal, .boolean_literal, .null_literal, .undefined_literal, .identifier, .collection_new, .reference_error, .type_error, .optional_base, .class_value, .out_new => |node| {
            comptime assertWalksAll(@typeInfo(@TypeOf(node)).pointer.child, .{});
            return expr;
        },
        // A logical right operand may never run. Rewriting it is still sound, since a rewrite
        // replaces an expression with an equivalent one and does not run it; a pass that MOVES
        // work must consult the kind.
        inline .binary_op, .logical_op => |node, tag| return rewriteVariant(expr, tag, node, .{ .left, .right }, r),
        inline .unary_op, .typeof, .string_length, .array_length, .function_length, .out_get => |node, tag| return rewriteVariant(expr, tag, node, .{.operand}, r),
        inline .delete_prop => |node, tag| return rewriteVariant(expr, tag, node, .{ .target, .key }, r),
        inline .conditional => |node, tag| return rewriteVariant(expr, tag, node, .{ .condition, .consequent, .alternate }, r),
        inline .optional_chain => |node, tag| return rewriteVariant(expr, tag, node, .{ .base, .consequent }, r),
        .update => |node| {
            const old_target = node.target.expression();
            const target = try rewriteExpression(old_target, r);
            const place = try updatePlace(target);
            const value = try rewriteOptional(node.value, r);
            if (same(target, old_target) and sameOptional(value, node.value)) return expr;
            return .{ .update = try with(r.arena, node, .{ .target = place, .value = value }) };
        },
        inline .boundary_check, .await, .yield => |node, tag| return rewriteVariant(expr, tag, node, .{.value}, r),
        inline .template_literal => |node, tag| return rewriteVariant(expr, tag, node, .{.expressions}, r),
        inline .array_literal => |node, tag| return rewriteVariant(expr, tag, node, .{.elements}, r),
        inline .index_access => |node, tag| return rewriteVariant(expr, tag, node, .{ .target, .index }, r),
        inline .new, .console_log, .date_components, .date_static, .global_call, .math_call, .object_static, .string_static, .typed_op, .extern_call => |node, tag| return rewriteVariant(expr, tag, node, .{.args}, r),
        inline .new_value, .array_op, .method_call, .dyn_method_call, .field_call, .number_op, .collection_op, .date_op, .regexp_op, .string_op, .promise_method => |node, tag| return rewriteVariant(expr, tag, node, .{ .target, .args }, r),
        inline .instanceof_value => |node, tag| return rewriteVariant(expr, tag, node, .{ .target, .ctor }, r),
        inline .instanceof, .field_access, .match_read, .regexp_read, .get_iterator, .dyn_field_access, .accessor_place, .method_value => |node, tag| return rewriteVariant(expr, tag, node, .{.target}, r),
        inline .iterator_next => |node, tag| return rewriteVariant(expr, tag, node, .{ .target, .sent }, r),
        inline .date_new, .error_new, .json_parse, .json_stringify, .promise_static => |node, tag| return rewriteVariant(expr, tag, node, .{.arg}, r),
        inline .promise_construct => |node, tag| return rewriteVariant(expr, tag, node, .{.executor}, r),
        inline .object_literal => |node, tag| return rewriteVariant(expr, tag, node, .{ .entries, .methods, .method_copies }, r),
        inline .dyn_object_literal => |node, tag| return rewriteVariant(expr, tag, node, .{.entries}, r),
        .function => |node| return .{ .function = try rewriteFunction(node, r) },
        inline .call => |node, tag| return rewriteVariant(expr, tag, node, .{ .callee, .args }, r),
    }
}
