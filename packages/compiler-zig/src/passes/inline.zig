//! Inlining: replace a call to a small, non-recursive function with the expression it returns.
//! `packages/compiler/src/passes/inline.ts` states the four conditions and which hazard each one
//! closes; the checks here are in the same order.

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("../hir/nodes.zig");
const types = @import("../hir/types.zig");
const rewrite = @import("rewrite.zig");
const hasName = @import("../hir/verify.zig").hasName;
const Error = rewrite.Error;
const Expression = nodes.Expression;
const FunctionDeclaration = nodes.FunctionDeclaration;
const FunctionExpr = nodes.FunctionExpr;
const Module = nodes.Module;
const Parameter = nodes.Parameter;
const Statement = nodes.Statement;

const Counts = std.StringHashMapUnmanaged(u32);
const Candidates = std.StringHashMapUnmanaged(Candidate);

const Candidate = struct {
    params: []const Parameter,
    result: Expression,
};

pub fn inlineCalls(arena: Allocator, module: *const Module) Error!*const Module {
    const bindings = try bindingCounts(arena, module);
    var candidates: Candidates = .empty;
    for (module.statements) |stmt| {
        // The HIR resolves identifiers by name alone, so a name bound twice cannot tell a call of
        // this `f` from one of a local `f` shadowing it, and inlining the wrong one is a wrong
        // program rather than a missed optimization.
        if (stmt != .function_declaration or bindings.get(stmt.function_declaration.name) != 1) continue;
        if (try candidateOf(arena, stmt.function_declaration)) |candidate| {
            try candidates.put(arena, stmt.function_declaration.name, candidate);
        }
    }
    if (candidates.count() == 0) return module;
    var site: CallSites = .{ .arena = arena, .candidates = &candidates };
    return rewrite.rewriteModule(module, rewrite.visiting(CallSites, arena, &site));
}

const Binder = struct {
    arena: Allocator,
    counts: Counts = .empty,

    fn bind(self: *Binder, name: []const u8) Allocator.Error!void {
        const slot = try self.counts.getOrPutValue(self.arena, name, 0);
        slot.value_ptr.* += 1;
    }

    fn bindParams(self: *Binder, function: *const FunctionExpr) Allocator.Error!void {
        for (function.params) |param| try self.bind(param.name);
    }

    pub fn expression(self: *Binder, expr: Expression) Error!Expression {
        if (expr == .function) try self.bindParams(expr.function);
        return expr;
    }

    pub fn statement(self: *Binder, stmt: Statement) Error!?Statement {
        switch (stmt) {
            .declaration => |node| try self.bind(node.name),
            .for_of_statement => |node| try self.bind(node.binding),
            .function_declaration => |node| try self.bind(node.name),
            .class_declaration => |node| {
                try self.bind(node.name);
                // A method hangs off the class, not off an expression slot, so the expression
                // hook never sees its parameters.
                for (node.methods) |method| try self.bindParams(method.@"fn");
                if (node.ctor) |ctor| try self.bindParams(ctor.@"fn");
            },
            else => {},
        }
        return stmt;
    }
};

/// How many times each name is bound anywhere in the module. A module-level function declaration
/// contributes its own one, so a count above one is exactly "also bound elsewhere".
fn bindingCounts(arena: Allocator, module: *const Module) Error!Counts {
    var binder: Binder = .{ .arena = arena };
    _ = try rewrite.rewriteModule(module, rewrite.visiting(Binder, arena, &binder));
    return binder.counts;
}

/// The function reduced to what inlining needs, or null when it fails a structural condition.
fn candidateOf(arena: Allocator, declaration: *const FunctionDeclaration) Error!?Candidate {
    const function = declaration.@"fn";
    // The flags are checked rather than inferred from `captures`: `needs_env` is also set when
    // something nested captures.
    if (function.needs_env or function.captures.len > 0 or function.env_vars.len > 0) return null;
    // A rest or a default is applied at the callee, and substituting the body would drop both.
    for (function.params) |param| {
        if (param.rest == true or param.default != null) return null;
    }
    if (function.body.statements.len != 1) return null;
    const only = function.body.statements[0];
    if (only != .return_statement) return null;
    const result = only.return_statement.value orelse return null;

    var uses: ParamUses = .{ .params = function.params };
    _ = try rewrite.rewriteExpression(result, rewrite.visiting(ParamUses, arena, &uses));
    if (uses.foreign or uses.rebound) return null;
    return .{ .params = function.params, .result = result };
}

/// What the body does with names. The rewriter is the visitor so this cannot fall behind
/// rewrite.zig when a node kind is added.
const ParamUses = struct {
    params: []const Parameter,
    /// It names something besides its parameters.
    foreign: bool = false,
    /// A nested scope binds a parameter's name. Substitution is textual over the whole result, so
    /// that scope would capture the argument (plan-notes 219). Over-approximates towards losing an
    /// inlining: a declaration in a nested block counts even though it could not capture a
    /// reference outside it.
    rebound: bool = false,

    pub fn expression(self: *ParamUses, expr: Expression) Error!Expression {
        switch (expr) {
            .identifier => |node| if (!hasName(self.params, node.name)) {
                self.foreign = true;
            },
            .function => |node| for (node.params) |param| {
                if (hasName(self.params, param.name)) self.rebound = true;
            },
            else => {},
        }
        return expr;
    }

    pub fn statement(self: *ParamUses, stmt: Statement) Error!?Statement {
        if (stmt == .declaration and hasName(self.params, stmt.declaration.name)) self.rebound = true;
        return stmt;
    }
};

/// Duplicable and effect-free: a parameter used twice duplicates its argument, and evaluation order
/// stops being a question.
fn isSubstitutable(expr: Expression) bool {
    return switch (expr) {
        .number_literal, .string_literal, .boolean_literal, .null_literal, .undefined_literal, .identifier => true,
        else => false,
    };
}

const CallSites = struct {
    arena: Allocator,
    candidates: *const Candidates,

    pub const expression = inlineCall;
};

const Substitution = struct {
    params: []const Parameter,
    args: []const Expression,

    pub fn expression(self: *Substitution, expr: Expression) Error!Expression {
        if (expr != .identifier) return expr;
        // From the end: a repeated parameter name binds the last argument, as the language does.
        var index = self.params.len;
        while (index > 0) {
            index -= 1;
            if (std.mem.eql(u8, self.params[index].name, expr.identifier.name)) return self.args[index];
        }
        return expr;
    }
};

fn inlineCall(site: *CallSites, expr: Expression) Error!Expression {
    if (expr != .call) return expr;
    const call = expr.call;
    // A spread call's one argument is the whole list, not the first parameter.
    if (call.spread == true or call.callee != .identifier) return expr;
    const candidate = site.candidates.get(call.callee.identifier.name) orelse return expr;
    if (candidate.params.len != call.args.len) return expr;

    for (candidate.params, call.args) |param, arg| {
        if (!isSubstitutable(arg) or !types.hTypeEquals(arg.getType(), param.type)) return expr;
    }
    // They can differ (a literal return type widening at the call), and a mismatch would hand the
    // verifier a subtree whose type contradicts its parent.
    if (!types.hTypeEquals(candidate.result.getType(), call.type)) return expr;

    var substitution: Substitution = .{ .params = candidate.params, .args = call.args };
    return rewrite.rewriteExpression(candidate.result, rewrite.visiting(Substitution, site.arena, &substitution));
}
