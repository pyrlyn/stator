//! HIR verifier. `packages/compiler/src/hir/verify.ts` keeps the reasoning for each rule; what is
//! here is what the Zig shape of the HIR changes about them.
//!
//! A problem is always a compiler bug, never a user error: the gate accepted the source and the
//! lowering produced this HIR. Hence the STA4xxx codes, and a list rather than a failure.
//!
//! The TypeScript verifier's STA4020 "missing HType" checks have no counterpart: `type` is a
//! non-optional pointer here, so the JSON reader refuses such a node before it gets this far. The
//! same goes for a name outside a table an enum now spells (`Math` methods, an `out-get` inner).

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("nodes.zig");
const types = @import("types.zig");
const Block = nodes.Block;
const Expression = nodes.Expression;
const FunctionExpr = nodes.FunctionExpr;
const HField = types.HField;
const HObject = types.HObject;
const HType = types.HType;
const H_BOOLEAN = types.H_BOOLEAN;
const H_NUMBER = types.H_NUMBER;
const H_REGEXP = types.H_REGEXP;
const H_STRING = types.H_STRING;
const H_UINT8ARRAY = types.H_UINT8ARRAY;
const H_UNDEFINED = types.H_UNDEFINED;
const Module = nodes.Module;
const Span = nodes.Span;
const Statement = nodes.Statement;
const hTypeAssignable = types.hTypeAssignable;
const hTypeEquals = types.hTypeEquals;

pub const VerifyProblem = struct {
    kind: []const u8,
    code: []const u8,
    span: Span,
    message: []const u8,
};

/// How deep a tree the compiler walks: the passes, this verifier, and so the emitter, which only
/// sees what passed here. Real programs peak near 45 levels and a debug build's frames overflow an
/// 8 MiB stack near a thousand, so a limit between the two makes generated source a diagnostic
/// rather than a segfault.
pub const MAX_NESTING = 400;

/// Every problem in source order, none when the HIR is sound. Only allocation can fail.
pub fn verifyHir(arena: Allocator, module: *const Module) Allocator.Error![]const VerifyProblem {
    var verifier: Verifier = .{ .arena = arena };
    var scope: Scope = .{};
    try verifier.hoistFunctions(module.statements, &scope);
    for (module.statements) |stmt| try verifier.statement(stmt, &scope, null);
    return verifier.problems.items;
}

/// One enclosing loop or switch. `continue` skips a switch, so `is_loop` is what tells the two
/// jumps apart, and getting it wrong is a `goto` to a label the emitter never wrote. A function
/// body is a wall rather than a target: jumps stop at it, and `return` looks for exactly it.
const Enclosing = struct {
    label: ?[]const u8 = null,
    is_loop: bool,
    is_function: bool = false,
    outer: ?*const Enclosing = null,
};

const Binding = struct {
    type: *const HType,
    /// Set while the binding's own initializer is verified: a closure there captures the binding,
    /// but a read on the initializer's own evaluation path would be a TDZ read.
    initializing: bool = false,
};

/// Parent-linked rather than copied at every nesting, which was quadratic in program size
/// (plan-notes 134). `own` lives in the arena, so a scope needs no teardown.
const Scope = struct {
    own: std.StringHashMapUnmanaged(Binding) = .empty,
    parent: ?*const Scope = null,
    is_function: bool = false,

    fn child(parent: *const Scope) Scope {
        return .{ .parent = parent };
    }

    fn functionChild(parent: *const Scope) Scope {
        return .{ .parent = parent, .is_function = true };
    }

    /// A binding still being initialized resolves only through a function boundary, because only
    /// a read that runs later can see it initialized.
    fn readable(self: *const Scope, name: []const u8) ?Binding {
        var deferred = false;
        var scope: ?*const Scope = self;
        while (scope) |current| : (scope = current.parent) {
            if (current.own.get(name)) |binding| {
                return if (binding.initializing and !deferred) null else binding;
            }
            deferred = deferred or current.is_function;
        }
        return null;
    }
};

const contains = @import("../support/names.zig").contains;

/// Whether any item, a field or a parameter, goes by `name`.
pub fn hasName(items: anytype, name: []const u8) bool {
    for (items) |item| {
        if (std.mem.eql(u8, item.name, name)) return true;
    }
    return false;
}

/// A fixed object's name its layout does not declare: no slot holds it, so the overflow table does
/// (docs/VALUE.md §4.24), and a dynamic node is the only way to reach it.
fn undeclaredMember(t: *const HType, name: []const u8) bool {
    return switch (t.*) {
        .object => |*object| !hasName(object.fields, name) and !hasName(object.methods, name),
        else => false,
    };
}

fn isArrayOp(name: []const u8) bool {
    return std.meta.stringToEnum(nodes.ArrayOpName, name) != null;
}

/// For a table's result word that is spelled as the HType kind it pins.
fn isKind(t: *const HType, kind: anytype) bool {
    return std.mem.eql(u8, @tagName(t.*), @tagName(kind));
}

fn kindName(comptime tag: std.meta.Tag(Expression)) []const u8 {
    return comptime blk: {
        const name = @tagName(tag);
        var out: [name.len]u8 = undefined;
        for (name, 0..) |char, index| out[index] = if (char == '_') '-' else char;
        const frozen = out;
        break :blk &frozen;
    };
}

fn expressionKind(expr: Expression) []const u8 {
    return switch (expr) {
        inline else => |_, tag| kindName(tag),
    };
}

fn collectionArity(collection: nodes.CollectionKind, op: nodes.CollectionOperation) ?u8 {
    return switch (collection) {
        .map => switch (op) {
            .set => 2,
            .get, .has, .delete, .forEach => 1,
            .clear, .size, .keys, .values, .entries => 0,
            else => null,
        },
        .set => switch (op) {
            .get, .set => null,
            .clear, .size, .keys, .values, .entries => 0,
            else => 1,
        },
    };
}

const ObjectStaticResult = enum { array, boolean, strings, unknown };
const ObjectStaticShape = struct { arity: u8, result: ObjectStaticResult };

/// The arity is the gate's, restated because the verifier trusts no earlier stage.
fn objectStaticShape(method: nodes.ObjectStaticMethod) ObjectStaticShape {
    return switch (method) {
        .assign => .{ .arity = 2, .result = .unknown },
        .entries, .values => .{ .arity = 1, .result = .array },
        .forInKeys, .getOwnPropertyNames, .keys => .{ .arity = 1, .result = .strings },
        .freeze, .fromEntries => .{ .arity = 1, .result = .unknown },
        .hasOwn => .{ .arity = 2, .result = .boolean },
        .isFrozen => .{ .arity = 1, .result = .boolean },
    };
}

/// One node's claims in order, under its kind, code and span. Only the first failure is reported:
/// each later claim presumes the earlier ones held.
const Check = struct {
    verifier: *Verifier,
    kind: []const u8,
    code: []const u8,
    span: Span,
    failed: bool = false,

    fn that(self: *Check, holds: bool, comptime format: []const u8, args: anytype) Allocator.Error!void {
        if (self.failed or holds) return;
        self.failed = true;
        try self.verifier.report(self.kind, self.code, self.span, format, args);
    }

    fn receiver(self: *Check, op: []const u8, target: *const HType, holds: bool) Allocator.Error!void {
        try self.that(holds, "{s} on a receiver of type '{s}'", .{ op, target });
    }

    fn arity(self: *Check, comptime owner: []const u8, op: []const u8, want: usize, given: usize) Allocator.Error!void {
        try self.that(given == want, owner ++ "{s} takes {d} arguments, not {d}", .{ op, want, given });
    }
};

const Verifier = struct {
    arena: Allocator,
    problems: std.ArrayList(VerifyProblem) = .empty,
    depth: u32 = 0,
    too_deep: bool = false,

    /// Reported once: past the limit every open branch arrives here with the same news.
    fn tooDeep(self: *Verifier, span: Span) Allocator.Error!void {
        if (self.too_deep) return;
        self.too_deep = true;
        try self.report("module", "STA4072", span, "internal error: nested deeper than {d} levels", .{MAX_NESTING});
    }

    /// A type among `args` prints as its name: nearly every message says which type it got.
    fn report(self: *Verifier, kind: []const u8, code: []const u8, span: Span, comptime format: []const u8, args: anytype) Allocator.Error!void {
        const Args = @TypeOf(args);
        var named: Named(Args) = undefined;
        inline for (0..@typeInfo(Args).@"struct".field_types.len) |i| {
            named[i] = if (comptime @TypeOf(args[i]) == *const HType) try self.name(args[i]) else args[i];
        }
        try self.problems.append(self.arena, .{
            .kind = kind,
            .code = code,
            .span = span,
            .message = try std.fmt.allocPrint(self.arena, format, named),
        });
    }

    fn Named(comptime Args: type) type {
        const given = @typeInfo(Args).@"struct".field_types;
        if (std.mem.indexOfScalar(type, given, *const HType) == null) return Args;
        var shown: [given.len]type = undefined;
        for (given, &shown) |T, *slot| slot.* = if (T == *const HType) []const u8 else T;
        return @Tuple(&shown);
    }

    fn name(self: *Verifier, t: *const HType) Allocator.Error![]const u8 {
        return types.hTypeName(self.arena, t);
    }

    /// Most rules are one condition and one message; the types are only named when `wrong`.
    fn reportIf(self: *Verifier, wrong: bool, kind: []const u8, code: []const u8, span: Span, comptime format: []const u8, args: anytype) Allocator.Error!void {
        if (wrong) try self.report(kind, code, span, format, args);
    }

    fn check(self: *Verifier, kind: []const u8, code: []const u8, span: Span) Check {
        return .{ .verifier = self, .kind = kind, .code = code, .span = span };
    }

    fn hoistFunctions(self: *Verifier, statements: []const Statement, scope: *Scope) Allocator.Error!void {
        for (statements) |stmt| {
            if (stmt == .function_declaration) {
                const declaration = stmt.function_declaration;
                try scope.own.put(self.arena, declaration.name, .{ .type = declaration.@"fn".type });
            }
        }
    }

    /// Receiver, arity and result agreement shared by `string-op` and `array-op`. The first
    /// disagreement wins; answers true when all of them agreed.
    fn receiverOpShape(
        self: *Verifier,
        kind: []const u8,
        code: []const u8,
        span: Span,
        op: []const u8,
        target: *const HType,
        receiver_agrees: bool,
        arg_count: usize,
        arity: u8,
        count_ok: bool,
        result: *const HType,
        want: ?*const HType,
        wants_iterator: bool,
    ) Allocator.Error!bool {
        if (!receiver_agrees) {
            try self.report(kind, code, span, "{s} on a receiver of type '{s}'", .{ op, target });
            return false;
        }
        if (!count_ok) {
            try self.report(kind, code, span, "{s} takes {d} arguments after padding, not {d}", .{ op, arity, arg_count });
            return false;
        }
        if (want) |wanted| {
            if (!hTypeEquals(result, wanted)) {
                try self.report(kind, code, span, "{s} results in '{s}', not '{s}'", .{ op, result, wanted });
                return false;
            }
        }
        if (wants_iterator and result.* != .iterator) {
            try self.report(kind, code, span, "{s} results in '{s}', not an iterator", .{ op, result });
            return false;
        }
        return true;
    }

    /// Every shape member is written and every written name is a member. A repeated name is an
    /// overwrite, not an error: the emitter stores in source order into one hidden slot.
    fn shapeCoverage(
        self: *Verifier,
        span: Span,
        shape_name: []const u8,
        members: []const HField,
        written: []const []const u8,
        writer_word: []const u8,
        member_word: []const u8,
    ) Allocator.Error!void {
        var seen: std.StringHashMapUnmanaged(void) = .empty;
        for (written) |item| {
            if ((try seen.getOrPut(self.arena, item)).found_existing) continue;
            try self.reportIf(!hasName(members, item), "object-literal", "STA4052", span, "{s} '{s}' names no {s} of shape '{s}'", .{ writer_word, item, member_word, shape_name });
        }
        for (members) |member| {
            try self.reportIf(!seen.contains(member.name), "object-literal", "STA4052", span, "shape '{s}' has {s} '{s}', which the literal does not write", .{ shape_name, member_word, member.name });
        }
    }

    /// Only an array can be indexed, and only Unknown may pretend to be one. The index-kind rule
    /// is what keeps the fixed-shape exception precise: `any` on a layout is still a lowering
    /// mistake.
    fn checkIndexable(self: *Verifier, target: Expression, index: Expression, kind: []const u8) Allocator.Error!void {
        const target_type = target.getType();
        switch (target_type.*) {
            .array, .unknown, .uint8array, .string => return,
            .object => switch (index.getType().*) {
                .object, .unknown, .string, .number => return,
                else => {},
            },
            else => {},
        }
        try self.report(kind, "STA4044", target.getSpan(), "index target has type '{s}', which is not indexable", .{target_type});
    }

    /// The stored slot is checked against the layout it claims to index: a disagreement between
    /// the lowering's field order and the type's is a silent read of the wrong field.
    fn checkField(self: *Verifier, target: Expression, field: []const u8, slot: i32, kind: []const u8) Allocator.Error!void {
        const target_type = target.getType();
        if (target_type.* != .object) {
            try self.report(kind, "STA4046", target.getSpan(), "field target has type '{s}', which has no fields", .{target_type});
            return;
        }
        const object = &target_type.object;
        const found = types.fieldSlot(object, field);
        try self.reportIf(found == null or @as(i64, @intCast(found.?)) != slot, kind, "STA4046", target.getSpan(), "field '{s}' is not slot {d} of {s}", .{ field, slot, object.name });
    }

    /// `jsrt_call_spread_at` reads one array without a tag test, and the lowering folds the spread
    /// list into exactly that.
    fn checkSpreadArguments(self: *Verifier, kind: []const u8, span: Span, args: []const Expression, spread: ?bool) Allocator.Error!void {
        if (spread != true) return;
        if (args.len == 1 and args[0].getType().* == .array) return;
        const first = if (args.len == 0) "none" else try self.name(args[0].getType());
        try self.report(kind, "STA4104", span, "spread {s} with {d} arguments, first typed '{s}', not one array", .{ kind, args.len, first });
    }

    /// The class on the node declares the method, which for an inherited one is an ancestor, so
    /// the test is ancestry rather than equality.
    fn checkMethodReceiver(
        self: *Verifier,
        kind: []const u8,
        span: Span,
        target: Expression,
        class_name: []const u8,
        method: []const u8,
        dispatch: nodes.Dispatch,
        slot: i32,
    ) Allocator.Error!void {
        const target_type = target.getType();
        const layout = types.classLayoutOf(target_type);
        const object: ?*const HObject = if (layout) |*found| found else null;
        if (object == null or
            (!std.mem.eql(u8, object.?.name, class_name) and !contains(object.?.bases, class_name)))
        {
            try self.report(kind, "STA4047", span, "receiver has type '{s}', not {s}", .{ target_type, class_name });
            return;
        }
        if (types.methodOf(object.?, method) == null) {
            try self.report(kind, "STA4047", span, "{s} has no method '{s}'", .{ class_name, method });
            return;
        }
        if (dispatch != .virtual) return;
        // What a virtual call indexes, resolved against the receiver's static type, so it gets the
        // check a field slot gets: an index that disagrees with its layout is a wrong call.
        const at = for (object.?.methods, 0..) |candidate, index| {
            if (std.mem.eql(u8, candidate.name, method)) break index;
        } else unreachable;
        try self.reportIf(@as(i64, @intCast(at)) != slot, kind, "STA4047", span, "method '{s}' is at slot {d}, not {d}", .{ method, at, slot });
    }

    fn checkIterable(self: *Verifier, iterable: Expression) Allocator.Error!void {
        const t = iterable.getType();
        switch (t.*) {
            .array, .string, .map, .set, .iterator, .unknown => {},
            else => try self.report("for-of-statement", "STA4045", iterable.getSpan(), "for-of iterable has type '{s}', which is not an array, string, Map, Set or iterator", .{t}),
        }
    }

    fn checkJump(self: *Verifier, stmt: Statement, label: ?[]const u8, enclosing: ?*const Enclosing) Allocator.Error!void {
        const wants_loop = stmt == .continue_statement;
        var candidate = enclosing;
        while (candidate) |entry| : (candidate = entry.outer) {
            if (entry.is_function or (wants_loop and !entry.is_loop)) continue;
            const wanted = label orelse return;
            if (entry.label) |own| {
                if (std.mem.eql(u8, own, wanted)) return;
            }
        }
        const what = if (label) |wanted|
            try std.fmt.allocPrint(self.arena, "a labelled '{s}'", .{wanted})
        else
            "an enclosing";
        const jump = if (wants_loop) "continue" else "break";
        const target = if (wants_loop) "loop" else "loop, switch, or labelled block";
        try self.report(
            if (wants_loop) "continue-statement" else "break-statement",
            "STA4029",
            stmt.getSpan(),
            "{s} has no {s} {s} to jump out of",
            .{ jump, what, target },
        );
    }

    fn loopFrame(label: ?[]const u8, outer: ?*const Enclosing) Enclosing {
        return .{ .label = label, .is_loop = true, .outer = outer };
    }

    fn statement(self: *Verifier, stmt: Statement, scope: *Scope, enclosing: ?*const Enclosing) Allocator.Error!void {
        const span = stmt.getSpan();
        if (self.depth >= MAX_NESTING) return self.tooDeep(span);
        self.depth += 1;
        defer self.depth -= 1;
        switch (stmt) {
            .declaration => |node| {
                if (node.value) |value| {
                    try scope.own.put(self.arena, node.name, .{ .type = node.type, .initializing = true });
                    try self.expression(value, scope);
                }
                try scope.own.put(self.arena, node.name, .{ .type = node.type });
            },
            .assignment => |node| {
                try self.expression(node.value, scope);
                const binding = scope.readable(node.target) orelse {
                    try self.report("assignment", "STA4003", span, "identifier '{s}' assigned before declaration", .{node.target});
                    return;
                };
                // Assignable rather than equal: a `Dog` is a legal value for an `Animal` binding.
                const value_type = node.value.getType();
                try self.reportIf(!hTypeAssignable(value_type, binding.type), "assignment", "STA4004", span, "assignment target type {s} does not match value type {s}", .{ binding.type, value_type });
            },
            .expression_statement => |node| try self.expression(node.expression, scope),
            .if_statement => |node| {
                try self.expression(node.condition, scope);
                try self.block(node.consequent, scope, enclosing);
                if (node.alternate) |alternate| try self.block(alternate, scope, enclosing);
            },
            inline .while_statement, .do_while_statement => |node| {
                const inner = loopFrame(node.label, enclosing);
                try self.expression(node.condition, scope);
                try self.block(node.body, scope, &inner);
            },
            .for_statement => |node| {
                const inner = loopFrame(node.label, enclosing);
                // The header sees the outer scope, which is also where `let i = 0` registers `i`;
                // only the update slot may jump.
                if (node.init) |init| try self.statement(init, scope, enclosing);
                if (node.condition) |condition| try self.expression(condition, scope);
                if (node.update) |update| try self.statement(update, scope, &inner);
                try self.block(node.body, scope, &inner);
            },
            .switch_statement => |node| {
                try self.expression(node.discriminant, scope);
                const inner: Enclosing = .{ .label = node.label, .is_loop = false, .outer = enclosing };
                for (node.clauses) |clause| try self.hoistFunctions(clause.statements, scope);
                var defaults: usize = 0;
                for (node.clauses) |clause| {
                    if (clause.@"test") |case_test| {
                        try self.expression(case_test, scope);
                    } else {
                        defaults += 1;
                    }
                    // Clauses are not blocks: a `let` in one is visible in the next.
                    for (clause.statements) |child| try self.statement(child, scope, &inner);
                }
                try self.reportIf(defaults > 1, "switch-statement", "STA4040", span, "switch has {d} default clauses; at most one is legal", .{defaults});
            },
            .break_statement => |node| try self.checkJump(stmt, node.label, enclosing),
            .continue_statement => |node| try self.checkJump(stmt, node.label, enclosing),
            .block => |node| {
                const labelled: Enclosing = .{ .label = node.label, .is_loop = false, .outer = enclosing };
                const inner = if (node.label != null) &labelled else enclosing;
                if (node.flatten == true) {
                    for (node.statements) |child| try self.statement(child, scope, inner);
                } else {
                    try self.block(node, scope, inner);
                }
            },
            .function_declaration => |node| try self.function(node.@"fn", scope),
            .index_assignment => |node| {
                try self.operands(scope, .{ node.target, node.index, node.value });
                try self.checkIndexable(node.target, node.index, "index-assignment");
            },
            .for_of_statement => |node| {
                try self.expression(node.iterable, scope);
                try self.checkIterable(node.iterable);
                const inner = loopFrame(node.label, enclosing);
                var loop_scope = Scope.child(scope);
                try loop_scope.own.put(self.arena, node.binding, .{ .type = nodes.forOfElementType(node.iterable.getType(), node.view) });
                try self.block(node.body, &loop_scope, &inner);
            },
            .field_assignment => |node| {
                try self.operands(scope, .{ node.target, node.value });
                try self.checkField(node.target, node.field, node.slot, "field-assignment");
            },
            .class_declaration => |node| {
                // Registered in one pass and verified in another: a static may call one written
                // below it, as a hoisted function could.
                for (node.statics) |decl| try scope.own.put(self.arena, decl.name, .{ .type = decl.type });
                for (node.statics) |decl| {
                    if (decl.value) |value| try self.expression(value, scope);
                }
                if (node.ctor) |ctor| try self.classMember(node, ctor, scope);
                for (node.methods) |method| try self.classMember(node, method, scope);
            },
            .return_statement => |node| {
                var inside_function = false;
                var candidate = enclosing;
                while (candidate) |entry| : (candidate = entry.outer) {
                    if (entry.is_function) inside_function = true;
                }
                try self.reportIf(!inside_function, "return-statement", "STA4042", span, "return statement outside a function", .{});
                if (node.value) |value| try self.expression(value, scope);
            },
            .super_call => |node| {
                try self.operands(scope, .{ node.receiver, node.args });
                // The base constructor writes slots, so the receiver must descend from it.
                const self_type = node.receiver.getType();
                const descends = self_type.* == .object and contains(self_type.object.bases, node.class_name);
                try self.reportIf(!descends, "super-call", "STA4051", span, "super call to '{s}' from a receiver of type '{s}'", .{ node.class_name, self_type });
            },
            .throw_statement => |node| try self.expression(node.value, scope),
            .try_statement => |node| {
                try self.reportIf(node.catch_block == null and node.finally_block == null, "try-statement", "STA4057", span, "try statement with neither catch nor finally", .{});
                try self.reportIf(node.catch_binding != null and node.catch_block == null, "try-statement", "STA4057", span, "catch binding without a catch block", .{});
                try self.block(node.try_block, scope, enclosing);
                if (node.catch_block) |catch_block| {
                    // Unknown by construction: anything can be thrown.
                    var catch_scope = Scope.child(scope);
                    if (node.catch_binding) |binding| {
                        try catch_scope.own.put(self.arena, binding, .{ .type = types.hUnknown(false) });
                    }
                    try self.block(catch_block, &catch_scope, enclosing);
                }
                if (node.finally_block) |finally_block| try self.block(finally_block, scope, enclosing);
            },
            .dyn_field_assignment => |node| {
                try self.operands(scope, .{ node.target, node.value });
                const target_type = node.target.getType();
                const array_length = target_type.* == .array and std.mem.eql(u8, node.field, "length");
                try self.reportIf(target_type.* != .unknown and target_type.* != .@"fn" and !array_length and !undeclaredMember(target_type, node.field), "dyn-field-assignment", "STA4059", span, "dynamic assignment to '{s}' on a target typed '{s}'", .{ node.field, target_type });
            },
        }
    }

    /// Each member must receive the instance it will read fields out of.
    fn classMember(self: *Verifier, class: *const nodes.ClassDeclaration, member: nodes.ClassMethod, scope: *Scope) Allocator.Error!void {
        const params = member.@"fn".params;
        const receiver: ?*const HType = if (params.len > 0) params[0].type else null;
        const layout = if (receiver) |r| types.classLayoutOf(r) else null;
        const takes_class = layout != null and std.mem.eql(u8, layout.?.name, class.name);
        try self.reportIf(!takes_class, "class-declaration", "STA4049", member.@"fn".span, "{s}.{s} does not take {s} as its receiver", .{ class.name, member.name, class.name });
        try self.function(member.@"fn", scope);
    }

    fn block(self: *Verifier, node: *const Block, parent: *const Scope, enclosing: ?*const Enclosing) Allocator.Error!void {
        var scope = Scope.child(parent);
        try self.hoistFunctions(node.statements, &scope);
        for (node.statements) |stmt| try self.statement(stmt, &scope, enclosing);
    }

    /// `enclosing` restarts here, so a `break` cannot escape into the caller's loop and a `return`
    /// is recognised as in-function.
    fn function(self: *Verifier, node: *const FunctionExpr, parent: *const Scope) Allocator.Error!void {
        var scope = Scope.functionChild(parent);
        if (node.self_binding) |binding| try scope.own.put(self.arena, binding, .{ .type = node.type });
        for (node.params) |*param| {
            try scope.own.put(self.arena, param.name, .{ .type = param.type });
            if (param.default) |default| {
                try self.expression(default, &scope);
                const default_type = default.getType();
                try self.reportIf(!hTypeAssignable(default_type, param.type), "function", "STA4004", param.span, "default parameter type {s} does not match value type {s}", .{ param.type, default_type });
            }
        }
        const wall: Enclosing = .{ .is_loop = false, .is_function = true };
        try self.block(node.body, &scope, &wall);
    }

    fn expressions(self: *Verifier, list: []const Expression, scope: *const Scope) Allocator.Error!void {
        for (list) |item| try self.expression(item, scope);
    }

    /// Every expression a node holds, in field order, which is the order they evaluate in.
    fn childrenOf(self: *Verifier, node: anytype, scope: *const Scope) Allocator.Error!void {
        const Node = @typeInfo(@TypeOf(node)).pointer.child;
        inline for (@typeInfo(Node).@"struct".field_names) |field| {
            const child = @field(node, field);
            switch (@TypeOf(child)) {
                Expression => try self.expression(child, scope),
                ?Expression => if (child) |present| try self.expression(present, scope),
                []const Expression => try self.expressions(child, scope),
                nodes.UpdatePlace => try self.expression(child.expression(), scope),
                else => {},
            }
        }
    }

    /// A node's children in evaluation order: each an expression or a list of them.
    fn operands(self: *Verifier, scope: *const Scope, children: anytype) Allocator.Error!void {
        inline for (children) |child| {
            if (@TypeOf(child) == Expression) try self.expression(child, scope) else try self.expressions(child, scope);
        }
    }

    /// Monomorphization removes type parameters by never building one, so one surviving here is a
    /// call that was never specialized, and there is no C to emit for it.
    fn expression(self: *Verifier, expr: Expression, scope: *const Scope) Allocator.Error!void {
        const t = expr.getType();
        const span = expr.getSpan();
        if (self.depth >= MAX_NESTING) return self.tooDeep(span);
        self.depth += 1;
        defer self.depth -= 1;
        if (types.hasTypeParam(t)) {
            const kind = expressionKind(expr);
            try self.report(kind, "STA4054", span, "{s} has the unsubstituted type '{s}'", .{ kind, t });
            return;
        }
        switch (expr) {
            // Each opens a scope or checks an entry before visiting the rest of it.
            .function, .object_literal, .dyn_object_literal => {},
            inline else => |node| try self.childrenOf(node, scope),
        }
        switch (expr) {
            .number_literal => try self.reportIf(!hTypeEquals(t, H_NUMBER), "number-literal", "STA4007", span, "number-literal must have type 'number', got '{s}'", .{t}),
            .string_literal => try self.reportIf(t.* != .string, "string-literal", "STA4008", span, "string-literal must have type 'string', got '{s}'", .{t}),
            .boolean_literal => try self.reportIf(!hTypeEquals(t, H_BOOLEAN), "boolean-literal", "STA4009", span, "boolean-literal must have type 'boolean', got '{s}'", .{t}),
            .null_literal => try self.reportIf(t.* != .null, "null-literal", "STA4022", span, "null-literal must have type 'null', got '{s}'", .{t}),
            .undefined_literal => try self.reportIf(t.* != .undefined, "undefined-literal", "STA4023", span, "undefined-literal must have type 'undefined', got '{s}'", .{t}),
            .identifier => |node| {
                const binding = scope.readable(node.name) orelse {
                    try self.report("identifier", "STA4002", span, "identifier '{s}' is not defined", .{node.name});
                    return;
                };
                try self.reportIf(!hTypeEquals(t, binding.type), "identifier", "STA4010", span, "identifier '{s}' has type '{s}' but is used as '{s}'", .{ node.name, binding.type, t });
            },
            .binary_op => |node| try self.binaryOp(node),
            .unary_op => |node| {
                const wanted = switch (node.operator) {
                    .@"!" => H_BOOLEAN,
                    .void => H_UNDEFINED,
                    else => H_NUMBER,
                };
                try self.reportIf(!hTypeEquals(t, wanted), "unary-op", "STA4025", span, "unary operator '{s}' result must be {s}, got '{s}'", .{ @tagName(node.operator), wanted, t });
            },
            .typeof => try self.reportIf(!hTypeEquals(t, H_STRING), "typeof", "STA4055", span, "typeof result must be string, got '{s}'", .{t}),
            .delete_prop => try self.reportIf(!hTypeEquals(t, H_BOOLEAN), "delete-prop", "STA4097", span, "delete result must be boolean, got '{s}'", .{t}),
            .boundary_check => |node| {
                // Both halves are ways to insert a check that does nothing. A concrete value of
                // ANOTHER type is not a no-op: it is the js-mode edge the check fails (plan-notes
                // 301).
                const value_type = node.value.getType();
                try self.reportIf(value_type.* != .unknown and hTypeAssignable(value_type, t), "boundary-check", "STA4056", span, "boundary check on a value of type '{s}', which is already concrete", .{value_type});
                try self.reportIf(t.* == .unknown, "boundary-check", "STA4056", span, "boundary check narrows to unknown, which checks nothing", .{});
            },
            .template_literal => |node| {
                try self.reportIf(node.quasis.len != node.expressions.len + 1, "template-literal", "STA4026", span, "template literal has {d} literal chunks for {d} substitutions; expected {d}", .{ node.quasis.len, node.expressions.len, node.expressions.len + 1 });
                try self.reportIf(!hTypeEquals(t, H_STRING), "template-literal", "STA4027", span, "template literal must have type 'string', got '{s}'", .{t});
            },
            .string_length => try self.reportIf(!hTypeEquals(t, H_NUMBER), "string-length", "STA4028", span, "string length must have type 'number', got '{s}'", .{t}),
            .function => |node| try self.function(node, scope),
            .call => |node| {
                const callee_type = node.callee.getType();
                try self.reportIf(callee_type.* != .@"fn" and callee_type.* != .unknown, "call", "STA4041", span, "callee has type '{s}', which is not callable", .{callee_type});
                try self.checkSpreadArguments("call", span, node.args, node.spread);
            },
            .extern_call => |node| try self.externCall(node),
            .array_length => try self.reportIf(!hTypeEquals(t, H_NUMBER), "array-length", "STA4043", span, "array length must have type 'number', got '{s}'", .{t}),
            .function_length => |node| {
                try self.reportIf(!hTypeEquals(t, H_NUMBER), "function-length", "STA4100", span, "function length must have type 'number', got '{s}'", .{t});
                const operand_type = node.operand.getType();
                try self.reportIf(operand_type.* != .@"fn", "function-length", "STA4100", span, "function length needs a function operand, got '{s}'", .{operand_type});
            },
            .index_access => |node| try self.checkIndexable(node.target, node.index, "index-access"),
            .console_log => |node| {
                const method = @tagName(node.method);
                var claim = self.check("console-log", "STA4019", span);
                try claim.that(nodes.consoleEntryPoint(node.method, node.args.len) != null, "console.{s} takes {d} arguments, not {d}", .{ method, nodes.CONSOLE_METHODS.get(node.method).arity, node.args.len });
                try claim.that(t.* == .undefined, "console.{s} must have type 'undefined', got '{s}'", .{ method, t });
            },
            .field_access => |node| try self.checkField(node.target, node.field, node.slot, "field-access"),
            .field_call => |node| try self.checkField(node.target, node.field, node.slot, "field-call"),
            .method_value => |node| try self.checkMethodReceiver("method-value", span, node.target, node.class_name, node.method, node.dispatch, node.slot),
            .method_call => |node| try self.checkMethodReceiver("method-call", span, node.target, node.class_name, node.method, node.dispatch, node.slot),
            .dyn_method_call => |node| {
                try self.checkSpreadArguments("dyn-method-call", span, node.args, node.spread);
                const target_type = node.target.getType();
                // A spread call has no typed arm to bypass. A declared field called by name reads
                // a fixed slot through `jsrt_get_prop`, and an array the checker widened to `any`
                // answers the bound Array.prototype method.
                const legal = node.spread == true or
                    target_type.* == .unknown or
                    target_type.* == .@"fn" or
                    undeclaredMember(target_type, node.method) or
                    (target_type.* == .object and hasName(target_type.object.fields, node.method)) or
                    (target_type.* == .array and isArrayOp(node.method));
                try self.reportIf(!legal, "dyn-method-call", "STA4059", span, "dynamic call of '{s}' with target '{s}', not Unknown", .{ node.method, target_type });
            },
            .new => |node| try self.reportIf(t.* != .object or !std.mem.eql(u8, t.object.name, node.class_name), "new", "STA4048", span, "new {s} has type '{s}'", .{ node.class_name, t }),
            .instanceof => |node| try self.reportIf(!hTypeEquals(t, H_BOOLEAN), "instanceof", "STA4050", span, "instanceof {s} has type '{s}'", .{ node.class_name, t }),
            .instanceof_value => try self.reportIf(!hTypeEquals(t, H_BOOLEAN), "instanceof-value", "STA4050", span, "instanceof has type '{s}'", .{t}),
            // Their children are all there is to check.
            .class_value, .optional_base, .logical_op, .array_literal, .new_value, .json_parse, .yield, .conditional, .optional_chain => {},
            .object_literal => |node| try self.objectLiteral(node, scope),
            .dyn_object_literal => |node| {
                for (node.entries) |entry| switch (entry) {
                    .accessor_entry => |accessor| {
                        try self.reportIf(accessor.get == null and accessor.set == null, "dyn-object-literal", "STA4059", span, "accessor '{s}' has neither a getter nor a setter", .{accessor.name});
                        if (accessor.get) |get| try self.expression(get, scope);
                        if (accessor.set) |set| try self.expression(set, scope);
                    },
                    .computed_entry => |computed| {
                        try self.expression(computed.key, scope);
                        try self.expression(computed.value, scope);
                    },
                    .object_entry => |plain| try self.expression(plain.value, scope),
                };
                try self.reportIf(t.* != .unknown, "dyn-object-literal", "STA4059", span, "dynamic object literal has type '{s}', not Unknown", .{t});
            },
            .accessor_place => |node| {
                try self.reportIf(node.target.getType().* != .object, "accessor-place", "STA4049", span, "accessor-place receiver must be an object", .{});
                try self.reportIf(node.get_slot < 0 and node.set_slot < 0, "accessor-place", "STA4067", span, "accessor '{s}' has neither half in {s}", .{ node.property, node.owner });
            },
            .dyn_field_access => |node| {
                const target_type = node.target.getType();
                const is_array = target_type.* == .array;
                const array_member = is_array and (std.mem.eql(u8, node.field, "length") or isArrayOp(node.field));
                const target_legal = target_type.* == .unknown or target_type.* == .object or target_type.* == .@"fn" or array_member;
                try self.reportIf(!target_legal or t.* != .unknown, "dyn-field-access", "STA4059", span, "dynamic read of '{s}' with target '{s}' and result '{s}'", .{ node.field, target_type, t });
            },
            .collection_new => |node| if (!isKind(t, node.collection)) {
                try self.report("collection-new", "STA4053", span, "new {s} has type '{s}'", .{ @tagName(node.collection), t });
            },
            .collection_op => |node| try self.collectionOp(node),
            .math_call => |node| {
                const method = @tagName(node.method);
                var claim = self.check("math-call", "STA4080", span);
                try claim.arity("Math.", method, nodes.MATH_METHODS.get(node.method), node.args.len);
                try claim.that(t.* == .number, "Math.{s} must return number, got {s}", .{ method, t });
            },
            .string_op => |node| {
                const shape = nodes.STRING_OPS.get(node.op);
                const want: ?*const HType = switch (shape.result) {
                    // `element` is unchecked, the array-op rule: the honest answer is Unknown.
                    .element, .match, .iterator => null,
                    .@"string-array" => try types.hArray(self.arena, H_STRING),
                    .number => H_NUMBER,
                    .boolean => H_BOOLEAN,
                    .string => H_STRING,
                };
                const target_type = node.target.getType();
                _ = try self.receiverOpShape("string-op", "STA4081", span, @tagName(node.op), target_type, target_type.* == .string, node.args.len, shape.arity, node.args.len == shape.arity, t, want, shape.result == .iterator);
            },
            .string_static => |node| try self.reportIf(t.* != .string, "string-static", "STA4099", span, "String.{s} must return string, got '{s}'", .{ @tagName(node.method), t }),
            .array_op => |node| {
                const shape = nodes.ARRAY_OPS.get(node.op);
                const target_type = node.target.getType();
                const want: ?*const HType = switch (shape.result) {
                    .self => target_type,
                    .undefined => H_UNDEFINED,
                    .number => H_NUMBER,
                    .boolean => H_BOOLEAN,
                    .string => H_STRING,
                    .checker, .element, .iterator, .mapped => null,
                };
                const count = node.args.len;
                const count_ok = if (shape.variadic)
                    count >= shape.arity
                else if (shape.max_arity) |max_arity|
                    count >= shape.arity and count <= max_arity
                else
                    count == shape.arity;
                const op = @tagName(node.op);
                const agrees = try self.receiverOpShape("array-op", "STA4082", span, op, target_type, target_type.* == .array, count, shape.arity, count_ok, t, want, shape.result == .iterator);
                // Only the kind is pinned: the element is the checker's answer, possibly narrowed.
                try self.reportIf(agrees and shape.result == .mapped and t.* != .array, "array-op", "STA4082", span, "{s} results in '{s}', not an array", .{ op, t });
            },
            .object_static => |node| {
                const method = @tagName(node.method);
                const shape = objectStaticShape(node.method);
                const want: ?*const HType = switch (shape.result) {
                    .strings => try types.hArray(self.arena, H_STRING),
                    .boolean => H_BOOLEAN,
                    .array, .unknown => null,
                };
                var claim = self.check("object-static", "STA4083", span);
                try claim.arity("Object.", method, shape.arity, node.args.len);
                if (want) |wanted| try claim.that(hTypeEquals(t, wanted), "Object.{s} results in '{s}', not '{s}'", .{ method, t, wanted });
                try claim.that(shape.result != .array or t.* == .array, "Object.{s} results in '{s}', not an array", .{ method, t });
            },
            .json_stringify => try self.reportIf(!hTypeEquals(t, H_STRING), "json-stringify", "STA4085", span, "JSON.stringify results in '{s}', not a string", .{t}),
            .regexp_literal => try self.reportIf(t.* != .regexp, "regexp-literal", "STA4086", span, "a regular-expression literal has type '{s}'", .{t}),
            .regexp_op => |node| try self.regexpOp(node),
            .date_new => try self.reportIf(t.* != .date, "date-new", "STA4092", span, "new Date results in '{s}', not a Date", .{t}),
            .error_new => |node| {
                // Pinned against the whole layout because `jsrt_error_new` writes slots by index.
                if (!hTypeEquals(t, nodes.errorHType(node.ctor))) {
                    const ctor = @tagName(node.ctor);
                    try self.report("error-new", "STA4095", span, "new {s} results in '{s}', not the {s} layout", .{ ctor, t, ctor });
                }
            },
            .typed_op => |node| try self.typedOp(node),
            .date_op => |node| {
                const want = nodes.DATE_OPS.get(node.op);
                const op = @tagName(node.op);
                const target_type = node.target.getType();
                var claim = self.check("date-op", "STA4092", span);
                try claim.receiver(op, target_type, target_type.* == .date);
                try claim.arity("", op, want.arity, node.args.len);
                try claim.that(hTypeEquals(t, if (want.result == .number) H_NUMBER else H_STRING), "{s} results in '{s}', not a {s}", .{ op, t, @tagName(want.result) });
            },
            .number_op => |node| {
                const target_type = node.target.getType();
                try self.reportIf(target_type.* != .number or node.args.len != 1 or !hTypeEquals(t, H_STRING), "number-op", "STA4103", span, "{s} on '{s}' with {d} arguments, typed '{s}'", .{ @tagName(node.op), target_type, node.args.len, t });
            },
            .date_components => |node| {
                var claim = self.check("date-components", "STA4092", span);
                try claim.that(node.args.len == 7, "new Date takes 7 components, not {d}", .{node.args.len});
                try claim.that(t.* == .date, "new Date results in '{s}', not a Date", .{t});
            },
            .date_static => |node| {
                const method = @tagName(node.method);
                var claim = self.check("date-static", "STA4092", span);
                try claim.arity("Date.", method, nodes.DATE_STATICS.get(node.method).arity, node.args.len);
                try claim.that(hTypeEquals(t, H_NUMBER), "Date.{s} results in '{s}', not a number", .{ method, t });
            },
            .global_call => |node| {
                const row = nodes.GLOBAL_CALLS.get(node.name);
                const typed = switch (row.result) {
                    // Whatever array the checker typed the call as.
                    .array => t.* == .array,
                    .unknown => t.* == .unknown,
                    .number => hTypeEquals(t, H_NUMBER),
                    .boolean => hTypeEquals(t, H_BOOLEAN),
                    .regexp => hTypeEquals(t, H_REGEXP),
                };
                const global = @tagName(node.name);
                var claim = self.check("global-call", "STA4102", span);
                try claim.arity("", global, row.arity, node.args.len);
                try claim.that(typed, "{s} results in '{s}', not a {s}", .{ global, t, @tagName(row.result) });
            },
            .await => |node| {
                // Only a promise peels: `await 1` is legal and its result is the operand's own.
                const value_type = node.value.getType();
                if (value_type.* == .promise and !hTypeEquals(t, value_type.promise.value)) {
                    try self.report("await", "STA4087", span, "await of '{s}' results in '{s}', not '{s}'", .{ value_type, t, value_type.promise.value });
                }
            },
            .promise_static => |node| {
                const method = @tagName(node.method);
                const arg_type = node.arg.getType();
                var claim = self.check("promise-static", "STA4088", span);
                try claim.that(t.* == .promise, "Promise.{s} results in '{s}', not a promise", .{ method, t });
                try claim.that(node.method != .all or arg_type.* == .array or arg_type.* == .unknown, "Promise.{s} takes an array, not '{s}'", .{ method, arg_type });
            },
            .promise_method => |node| {
                const method = @tagName(node.method);
                const target_type = node.target.getType();
                var claim = self.check("promise-method", "STA4094", span);
                try claim.that(target_type.* == .promise or target_type.* == .unknown, "Promise.prototype.{s} on '{s}', not a promise", .{ method, target_type });
                try claim.that(t.* == .promise, "Promise.prototype.{s} results in '{s}', not a promise", .{ method, t });
            },
            .promise_construct => try self.reportIf(t.* != .promise, "promise-construct", "STA4094", span, "new Promise results in '{s}', not a promise", .{t}),
            .match_read => |node| {
                const field = @tagName(node.field);
                const target_type = node.target.getType();
                var claim = self.check("match-read", "STA4089", span);
                try claim.that(target_type.* == .unknown, "{s} on a receiver of type '{s}', not the unknown a match-or-null is", .{ field, target_type });
                const want = nodes.MATCH_FIELDS.get(node.field);
                try claim.that(isKind(t, want), "{s} results in '{s}', not '{s}'", .{ field, t, @tagName(want) });
            },
            .regexp_read => |node| {
                const want = nodes.REGEXP_FIELDS.get(node.field).result;
                const field = @tagName(node.field);
                const target_type = node.target.getType();
                var claim = self.check("regexp-read", "STA4090", span);
                try claim.receiver(field, target_type, target_type.* == .regexp);
                try claim.that(isKind(t, want), "{s} results in '{s}', not '{s}'", .{ field, t, @tagName(want) });
            },
            .iterator_next => |node| {
                const target_type = node.target.getType();
                try self.reportIf(target_type.* != .iterator, "iterator-next", "STA4045", span, "{s}() on a receiver of type '{s}'", .{ @tagName(node.op), target_type });
            },
            .get_iterator => |node| {
                // A concrete element would type the for-of binding against values the runtime
                // never promised, unchecked; a Uint8Array alone answers a byte by construction.
                const bytes = node.target.getType().* == .uint8array;
                const element = if (bytes) "number" else "unknown";
                const agrees = t.* == .iterator and (if (bytes) t.iterator.element.* == .number else t.iterator.element.* == .unknown);
                try self.reportIf(!agrees, "get-iterator", "STA4045", span, "get-iterator has type '{s}', not an iterator with a(n) {s} element", .{ t, element });
            },
            .update => |node| try self.reportIf((node.operator == .@"++" or node.operator == .@"--") and !hTypeEquals(t, H_NUMBER), "update", "STA4013", span, "update result must be number, got {s}", .{t}),
            .type_error => |node| {
                try self.reportIf(!hTypeEquals(t, types.hUnknown(false)), "type-error", "STA4020", span, "type-error must have type 'unknown', got '{s}'", .{t});
                try self.reportIf(node.message.len == 0, "type-error", "STA4020", span, "type-error must carry a message", .{});
            },
            .reference_error => |node| {
                try self.reportIf(t.* != .unknown, "reference-error", "STA4096", span, "reference-error must have type 'unknown', got '{s}'", .{t});
                try self.reportIf(node.name.len == 0, "reference-error", "STA4096", span, "reference-error must carry the name it failed to resolve", .{});
            },
            .out_new => try self.reportIf(t.* != .unknown, "out-new", "STA4098", span, "out-slot must have type 'unknown', got '{s}'", .{t}),
            .out_get => try self.reportIf(t.* != .unknown, "out-get", "STA4098", span, "out-slot read must have type 'unknown', got '{s}'", .{t}),
        }
    }

    fn binaryOp(self: *Verifier, node: *const nodes.BinaryOp) Allocator.Error!void {
        const t = node.type;
        const span = node.span;
        switch (node.operator) {
            // `+` is absent because a string operand makes it concatenate.
            .@"-", .@"*", .@"/", .@"%", .@"**" => {
                try self.reportIf(!arithmeticOperand(node.left.getType()), "binary-op", "STA4011", node.left.getSpan(), "arithmetic operand must be number, got {s}", .{node.left.getType()});
                try self.reportIf(!arithmeticOperand(node.right.getType()), "binary-op", "STA4012", node.right.getSpan(), "arithmetic operand must be number, got {s}", .{node.right.getType()});
                try self.reportIf(!hTypeEquals(t, H_NUMBER), "binary-op", "STA4013", span, "arithmetic operator result must be number, got {s}", .{t});
            },
            .@"<", .@">", .@"<=", .@">=" => try self.reportIf(!hTypeEquals(t, H_BOOLEAN), "binary-op", "STA4016", span, "comparison result must be boolean, got {s}", .{t}),
            // The constraint is on the result: `>>>` can exceed what int32 holds
            // (docs/NUMERIC.md §4.2), so a pass must not assume otherwise.
            .@"&", .@"|", .@"^", .@"<<", .@">>", .@">>>" => try self.reportIf(!hTypeEquals(t, H_NUMBER), "binary-op", "STA4024", span, "bitwise operator result must be number, got '{s}'", .{t}),
            .@"==", .@"!=", .@"===", .@"!==" => try self.reportIf(!hTypeEquals(t, H_BOOLEAN), "binary-op", "STA4018", span, "equality result must be boolean, got {s}", .{t}),
            .in => try self.reportIf(!hTypeEquals(t, H_BOOLEAN), "binary-op", "STA4018", span, "'in' result must be boolean, got {s}", .{t}),
            .@"," => try self.reportIf(!hTypeEquals(t, node.right.getType()), "binary-op", "STA4013", span, "comma operator result must match the right operand, got {s}", .{t}),
            .@"+" => {},
        }
    }

    /// The emitter wraps every operand in `jsrt_to_number`. A composite is still refused: the gate
    /// keeps those out, because their ToPrimitive runs user code.
    fn arithmeticOperand(t: *const HType) bool {
        return hTypeEquals(t, H_NUMBER) or switch (t.*) {
            .unknown, .string, .boolean, .null, .undefined => true,
            else => false,
        };
    }

    /// The four claims a direct C call rests on, none of which the C compiler can check across
    /// `jsrt_value`: the count, each argument's ABI kind, the boxed result, the error convention.
    fn externCall(self: *Verifier, node: *const nodes.ExternCall) Allocator.Error!void {
        const t = node.type;
        const span = node.span;
        const callee = node.ts_name;
        if (node.args.len != node.arg_kinds.len or node.args.len != node.arg_tags.len) {
            try self.report("extern-call", "STA4098", span, "extern call '{s}' takes {d} arguments, not {d}", .{ callee, node.arg_kinds.len, node.args.len });
            return;
        }
        for (node.args, node.arg_kinds, 0..) |arg, kind, index| {
            const arg_type = arg.getType();
            const want: *const HType = switch (kind) {
                // Every legitimate slot lowers as `unknown`; anything else has no address the
                // emitter can take.
                .@"out-pointer" => {
                    try self.reportIf(arg_type.* != .unknown, "extern-call", "STA4098", span, "extern call '{s}' argument {d} has type '{s}', not an out-slot", .{ callee, index, arg_type });
                    continue;
                },
                // No tag answers "is this handle honest", so what is rejected is only a value that
                // is never a handle.
                .pointer => {
                    try self.reportIf(arg_type.* != .unknown and arg_type.* != .object, "extern-call", "STA4098", span, "extern call '{s}' argument {d} has type '{s}', not an opaque handle", .{ callee, index, arg_type });
                    continue;
                },
                .number => H_NUMBER,
                .boolean => H_BOOLEAN,
                .cstring, .@"cstring-owned" => H_STRING,
                .bytes => H_UINT8ARRAY,
                .value, .void => continue,
            };
            // A `bytes` slot takes any view, a subclass instance's included (plan/T11.6a): the
            // callee reads the layout, which the class tag does not change.
            const fits = if (kind == .bytes) hTypeAssignable(arg_type, want) else hTypeEquals(arg_type, want);
            try self.reportIf(!fits, "extern-call", "STA4098", span, "extern call '{s}' argument {d} has type '{s}', not '{s}'", .{ callee, index, arg_type, want });
        }
        const result = nodes.externKindHType(node.ret_kind);
        try self.reportIf(!hTypeEquals(t, result), "extern-call", "STA4098", span, "extern call '{s}' results in '{s}', not '{s}'", .{ callee, t, result });
        if (node.@"error") |convention| {
            try self.reportIf(try nodes.externConventionMismatch(self.arena, node.ret_kind, convention) != null, "extern-call", "STA4098", span, "extern call '{s}' uses the {s} convention on a '{s}' return", .{ callee, @tagName(convention), @tagName(node.ret_kind) });
        }
    }

    /// Entries are in evaluation order and the shape is the layout, which need not agree (a
    /// reordering annotation or a spread supplies it, plan-notes 181). What must hold is that the
    /// literal covers the shape exactly.
    fn objectLiteral(self: *Verifier, node: *const nodes.ObjectLiteral, scope: *const Scope) Allocator.Error!void {
        const t = node.type;
        const span = node.span;
        for (node.entries) |entry| try self.expression(entry.value, scope);
        for (node.methods) |method| try self.function(method.@"fn", scope);
        for (node.method_copies) |copy| try self.expression(.{ .method_value = copy.value }, scope);
        if (t.* != .object) {
            try self.report("object-literal", "STA4052", span, "object literal has type '{s}', not a shape", .{t});
            return;
        }
        const shape = &t.object;
        const shape_name = try self.name(t);
        const field_writers = try self.arena.alloc([]const u8, node.entries.len);
        for (node.entries, field_writers) |entry, *writer| writer.* = entry.name;
        try self.shapeCoverage(span, shape_name, shape.fields, field_writers, "entry", "field");

        const method_writers = try self.arena.alloc([]const u8, node.methods.len + node.method_copies.len);
        for (node.methods, method_writers[0..node.methods.len]) |method, *writer| writer.* = method.name;
        for (node.method_copies, method_writers[node.methods.len..]) |copy, *writer| writer.* = copy.name;
        try self.shapeCoverage(span, shape_name, shape.methods, method_writers, "method", "method");

        for (node.method_copies) |copy| {
            try self.reportIf(copy.at > node.entries.len, "object-literal", "STA4052", span, "spread copy of method '{s}' is positioned past its entries", .{copy.name});
        }
    }

    /// Each operation is one runtime function with a fixed C signature and every argument the same
    /// C type, so neither a wrong receiver nor a wrong count is anything clang can catch.
    fn collectionOp(self: *Verifier, node: *const nodes.CollectionOp) Allocator.Error!void {
        const op = @tagName(node.op);
        const target_type = node.target.getType();
        var claim = self.check("collection-op", "STA4053", node.span);
        try claim.receiver(op, target_type, isKind(target_type, node.collection));
        const arity = collectionArity(node.collection, node.op);
        try claim.that(arity != null, "'{s}' is not an operation of a {s}", .{ op, @tagName(node.collection) });
        if (arity) |count| try claim.arity("", op, count, node.args.len);
        const set_op = std.meta.stringToEnum(nodes.SetOperation, op) orelse return;
        // The one family whose argument has a kind: the runtime reads it as a JSRTMap, so anything
        // else is memory corruption rather than a wrong answer.
        const answers = nodes.SET_OPS.get(set_op);
        const set = node.args.len > 0 and node.args[0].getType().* == .set;
        const given = if (set or node.args.len == 0) "nothing" else try self.name(node.args[0].getType());
        try claim.that(set, "{s} takes a Set, not '{s}'", .{ op, given });
        try claim.that(isKind(node.type, answers), "{s} answers a {s}, not '{s}'", .{ op, @tagName(answers), node.type });
    }

    /// The bridge dereferences a JSRTRegExp without asking, so a wrong receiver is memory
    /// corruption rather than a wrong answer. The argument is the runtime's to settle.
    fn regexpOp(self: *Verifier, node: *const nodes.RegExpOp) Allocator.Error!void {
        const t = node.type;
        const op = @tagName(node.op);
        const shape = nodes.REGEXP_OPS.get(node.op);
        const target_type = node.target.getType();
        var claim = self.check("regexp-op", "STA4086", node.span);
        try claim.receiver(op, target_type, target_type.* == .regexp);
        try claim.arity("", op, shape.arity, node.args.len);
        switch (shape.result) {
            .boolean => try claim.that(hTypeEquals(t, H_BOOLEAN), "{s} results in '{s}', not a boolean", .{ op, t }),
            .string => try claim.that(hTypeEquals(t, H_STRING), "{s} results in '{s}', not a string", .{ op, t }),
            // `exec` answers a match array or null, and the HIR has no union.
            .match => try claim.that(t.* == .unknown, "{s} results in '{s}', not the unknown a match-or-null is", .{ op, t }),
        }
    }

    /// The receiver kind, the padded arity and the result are all the row's, and none of them is a
    /// source property, so a disagreement is a lowering at odds with its own table.
    fn typedOp(self: *Verifier, node: *const nodes.TypedOp) Allocator.Error!void {
        const t = node.type;
        const span = node.span;
        const want = nodes.TYPED_OPS.get(node.op);
        const op = @tagName(node.op);
        const count = @as(usize, want.arity) + @intFromBool(want.receiver != null);
        const result = nodes.typedResultType(want.result);
        if (want.receiver) |receiver| {
            const first: ?*const HType = if (node.args.len > 0) node.args[0].getType() else null;
            if (first == null or !isKind(first.?, receiver)) {
                const given = if (first) |found| try self.name(found) else "nothing";
                try self.report("typed-op", "STA4101", span, "{s} on a receiver of type '{s}'", .{ op, given });
                return;
            }
        }
        if (node.args.len != count) {
            try self.report("typed-op", "STA4101", span, "{s} takes {d} operands, not {d}", .{ op, count, node.args.len });
        } else if (node.view_class) |class| {
            const stamped = node.op == .@"new Uint8Array" and t.* == .uint8array and t.uint8array.subclass != null and
                std.mem.eql(u8, t.uint8array.subclass.?.name, class);
            try self.reportIf(!stamped, "typed-op", "STA4101", span, "{s} stamped {s} results in '{s}'", .{ op, class, t });
        } else try self.reportIf(!hTypeEquals(t, result), "typed-op", "STA4101", span, "{s} results in '{s}', not '{s}'", .{ op, t, result });
    }
};

const testing = std.testing;
const sample = @import("sample.zig");

test "a read of a name nothing declared is reported" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const module = try sample.moduleOf(arena, &.{try sample.expressionStatement(arena, try sample.identifier(arena, "x", H_NUMBER))});
    const problems = try verifyHir(arena, module);
    try testing.expectEqual(@as(usize, 1), problems.len);
    try testing.expectEqualStrings("STA4002", problems[0].code);
    try testing.expectEqualStrings("identifier 'x' is not defined", problems[0].message);
}

test "a binding's own initializer may not read it, but a closure there may" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const direct = try sample.identifier(arena, "x", H_NUMBER);
    const declaration = try sample.declaration(arena, "x", H_NUMBER, direct);
    const problems = try verifyHir(arena, try sample.moduleOf(arena, &.{declaration}));
    try testing.expectEqual(@as(usize, 1), problems.len);
    try testing.expectEqualStrings("STA4002", problems[0].code);

    const closure: Expression = .{ .function = try sample.function(arena, types.hUnknown(false), &.{}, &.{try sample.expressionStatement(arena, direct)}) };
    const deferred = try sample.declaration(arena, "x", H_NUMBER, closure);
    try testing.expectEqual(@as(usize, 0), (try verifyHir(arena, try sample.moduleOf(arena, &.{deferred}))).len);
}

test "continue skips a switch to find its loop, and stops at a function" {
    var state = std.heap.ArenaAllocator.init(testing.allocator);
    defer state.deinit();
    const arena = state.allocator();
    const jump: Statement = .{ .continue_statement = try sample.node(arena, nodes.ContinueStatement{ .type = H_UNDEFINED, .span = sample.span }) };
    const clauses = [_]nodes.SwitchClause{.{ .statements = &.{jump} }};
    const inner: Statement = .{ .switch_statement = try sample.node(arena, nodes.SwitchStatement{
        .type = H_UNDEFINED,
        .span = sample.span,
        .discriminant = try sample.literal(arena, 0),
        .clauses = &clauses,
    }) };
    try testing.expectEqual(@as(usize, 1), (try verifyHir(arena, try sample.moduleOf(arena, &.{inner}))).len);

    const loop: Statement = .{ .for_statement = try sample.node(arena, nodes.ForStatement{
        .type = H_UNDEFINED,
        .span = sample.span,
        .body = try sample.block(arena, &.{inner}),
    }) };
    try testing.expectEqual(@as(usize, 0), (try verifyHir(arena, try sample.moduleOf(arena, &.{loop}))).len);
}
