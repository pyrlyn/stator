//! Dead-code elimination and tree-shaking. `packages/compiler/src/passes/dce.ts` keeps the
//! reasoning. Each elimination rests on a fact about control flow, never about values: a value
//! question answered wrongly deletes an observable effect.

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("../hir/nodes.zig");
const rewrite = @import("rewrite.zig");
const Error = rewrite.Error;
const Expression = nodes.Expression;
const FunctionDeclaration = nodes.FunctionDeclaration;
const Module = nodes.Module;
const Statement = nodes.Statement;

pub fn eliminateDeadCode(arena: Allocator, module: *const Module, roots: []const []const u8) Error!*const Module {
    var pruner: Pruner = .{ .arena = arena };
    const pruned = try rewrite.rewriteModule(module, rewrite.visiting(Pruner, arena, &pruner));
    return shakeFunctions(arena, pruned, roots);
}

/// Only the three direct jumps: an `if` whose branches both return is the first step onto a lattice
/// where each step buys a rarer program and widens what a bug here could delete.
fn terminates(stmt: Statement) bool {
    return stmt == .return_statement or stmt == .break_statement or stmt == .continue_statement;
}

/// Function declarations survive the cut: they are hoisted, so one written below a `return` still
/// holds its binding for the code above it. `let`, `const` and `class` have a temporal dead zone
/// and bind nothing when unreachable.
fn dropUnreachable(arena: Allocator, statements: []const Statement) Error![]const Statement {
    const cut = for (statements, 0..) |stmt, index| {
        if (terminates(stmt)) break index;
    } else return statements;
    if (cut == statements.len - 1) return statements;

    var kept: std.ArrayList(Statement) = .empty;
    try kept.appendSlice(arena, statements[0 .. cut + 1]);
    for (statements[cut + 1 ..]) |stmt| {
        if (stmt == .function_declaration) try kept.append(arena, stmt);
    }
    return if (kept.items.len == statements.len) statements else kept.items;
}

/// Only literal nodes qualify: deleting the branch of `if (f())` would delete the call.
fn literalTruth(condition: Expression) ?bool {
    return switch (condition) {
        .number_literal => |node| node.value != 0 and !std.math.isNan(node.value),
        .string_literal => |node| node.value.len != 0,
        .boolean_literal => |node| node.value,
        .null_literal, .undefined_literal => false,
        else => null,
    };
}

const Pruner = struct {
    arena: Allocator,

    pub fn statements(_: *Pruner, arena: Allocator, list: []const Statement) Error![]const Statement {
        return dropUnreachable(arena, list);
    }

    pub fn statement(self: *Pruner, stmt: Statement) Error!?Statement {
        switch (stmt) {
            // The taken branch stays a block: it is its own scope, and splicing would promote its
            // `let` bindings into the enclosing one, where a later declaration becomes a
            // redeclaration.
            .if_statement => |node| {
                const truth = literalTruth(node.condition) orelse return stmt;
                const taken = (if (truth) node.consequent else node.alternate) orelse return null;
                return .{ .block = taken };
            },
            // `while (true)` is left alone: its body repeats, so it is not its body.
            .while_statement => |node| return if (literalTruth(node.condition) == false) null else stmt,
            // A false test removes the loop but not the body, which runs once. Unless the body
            // jumps: `break` and `continue` name their target by position, and deleting the loop
            // would retarget them at the next enclosing one (plan-notes 218).
            .do_while_statement => |node| {
                if (literalTruth(node.condition) == false and !try containsJump(self.arena, node.body.statements)) {
                    return .{ .block = node.body };
                }
                return stmt;
            },
            else => return stmt,
        }
    }
};

const JumpFinder = struct {
    found: bool = false,

    pub fn statement(self: *JumpFinder, stmt: Statement) Error!?Statement {
        if (stmt == .break_statement or stmt == .continue_statement) self.found = true;
        return stmt;
    }
};

/// Coarser than "targets this loop" on purpose: a nested loop's own jump costs one loop that stays
/// in the output, where the opposite mistake costs a retargeted jump.
fn containsJump(arena: Allocator, statements: []const Statement) Error!bool {
    var finder: JumpFinder = .{};
    _ = try rewrite.rewriteStatements(statements, rewrite.visiting(JumpFinder, arena, &finder));
    return finder.found;
}

/// Over-approximates on purpose: keeping dead code is a missed optimization, and deleting live code
/// is a compiler bug.
const References = struct {
    arena: Allocator,
    pending: std.ArrayList([]const u8) = .empty,

    pub fn expression(self: *References, expr: Expression) Error!Expression {
        if (expr == .identifier) try self.pending.append(self.arena, expr.identifier.name);
        return expr;
    }

    fn rewriter(self: *References) rewrite.Rewriter {
        return rewrite.visiting(References, self.arena, self);
    }
};

/// Drop module-level functions nothing can reach, closing over calls transitively so a chain of
/// functions that only call each other dies as a group. Only functions: `new C()` names its class
/// by string, and a shake that cannot see a reference deletes live code.
fn shakeFunctions(arena: Allocator, module: *const Module, roots: []const []const u8) Error!*const Module {
    var declared: std.StringHashMapUnmanaged(*const FunctionDeclaration) = .empty;
    for (module.statements) |stmt| {
        if (stmt == .function_declaration) try declared.put(arena, stmt.function_declaration.name, stmt.function_declaration);
    }
    if (declared.count() == 0) return module;

    var references: References = .{ .arena = arena };
    for (module.statements) |stmt| {
        if (stmt == .function_declaration) continue;
        _ = try rewrite.rewriteStatement(stmt, references.rewriter());
    }
    try references.pending.appendSlice(arena, roots);

    var live: std.StringHashMapUnmanaged(void) = .empty;
    while (references.pending.pop()) |name| {
        const declaration = declared.get(name) orelse continue;
        const entry = try live.getOrPut(arena, name);
        if (entry.found_existing) continue;
        _ = try rewrite.rewriteStatements(declaration.@"fn".body.statements, references.rewriter());
        for (declaration.@"fn".params) |param| {
            if (param.default) |default| _ = try rewrite.rewriteExpression(default, references.rewriter());
        }
    }

    var kept: std.ArrayList(Statement) = .empty;
    for (module.statements) |stmt| {
        if (stmt != .function_declaration or live.contains(stmt.function_declaration.name)) {
            try kept.append(arena, stmt);
        }
    }
    if (kept.items.len == module.statements.len) return module;
    const shaken = try arena.create(Module);
    shaken.* = module.*;
    shaken.statements = kept.items;
    return shaken;
}
