//! The resolver (docs/INTERPRETER.md §2): one pass over a script that declares every binding in
//! the scope that owns it and resolves every reference to its binding, or to the global object.
//! A binding a nested function reads is `captured`: the compiler stores it in an environment
//! slot, exactly as compiled code stores a captured variable (`JSRTEnv`), and every other binding
//! in a register of its function's frame.

const std = @import("std");
const Allocator = std.mem.Allocator;
const parse = @import("parse.zig");

const ast = parse.ast;
const Node = ast.Node;
const Func = ast.Func;

pub const Kind = enum {
    @"var",
    let,
    @"const",
    class,
    function,
    param,
    catch_param,
    /// A non-arrow function's receiver.
    this,
    /// A non-arrow function's `arguments` object, made only when something reads it.
    arguments,
    /// A named function expression's own name: read-only, shadowed by the function's own bindings.
    callee,

    /// Has a temporal dead zone: a read before the declaration runs is a ReferenceError.
    pub fn hasTdz(k: Kind) bool {
        return k == .let or k == .@"const" or k == .class;
    }

    pub fn isConst(k: Kind) bool {
        return k == .@"const" or k == .callee;
    }
};

pub const Binding = struct {
    name: []const u8,
    kind: Kind,
    scope: *Scope,
    captured: bool = false,
    /// Set by the compiler: a register of the frame, or a slot of the scope's environment.
    slot: u16 = 0,
};

pub const Scope = struct {
    parent: ?*Scope,
    func: *Function,
    bindings: std.StringArrayHashMapUnmanaged(*Binding) = .empty,
    /// The script's top scope: its declarations are the global object's and the global lexical
    /// environment's, looked up by name (ECMA-262 GlobalDeclarationInstantiation).
    global: bool = false,
    /// Set by the compiler: how many of the bindings are captured, which is the size of the
    /// environment the scope pushes on entry (none when zero).
    env_slots: u16 = 0,

    pub fn hasEnv(s: *const Scope) bool {
        return s.env_slots > 0;
    }

    pub fn lookup(s: *Scope, name: []const u8) ?*Binding {
        var cur: ?*Scope = s;
        while (cur) |sc| : (cur = sc.parent) {
            if (sc.bindings.get(name)) |b| return b;
        }
        return null;
    }
};

pub const Function = struct {
    /// Null for the script itself.
    node: ?*Node,
    /// Parameters, `var`s and the body's top-level lexical declarations.
    scope: *Scope,
    /// The scope that holds a named function expression's own name, outside `scope`.
    name_scope: ?*Scope = null,
    parent: ?*Function,
    arrow: bool,
    strict: bool,
    /// Every scope of the function, outermost first, for the compiler's slot assignment.
    scopes: std.ArrayListUnmanaged(*Scope) = .empty,
};

pub const Resolution = struct {
    script: *Function,
    /// The scope each scope-making node opens: a function, a block, a `for`, a `catch`, a
    /// `switch`. A block declares into the function's scope when it is the function's body.
    scopes: std.AutoHashMapUnmanaged(*const Node, *Scope) = .empty,
    functions: std.AutoHashMapUnmanaged(*const Node, *Function) = .empty,
    /// Every resolved reference, keyed by its identifier (or `this`) node; an absent entry is a
    /// global name.
    refs: std.AutoHashMapUnmanaged(*const Node, *Binding) = .empty,
};

pub fn resolve(a: Allocator, root: *Node, strict: bool) Allocator.Error!Resolution {
    var r: Resolver = .{ .a = a, .res = .{ .script = undefined } };
    const f = try r.newFunction(null, null, false, strict or hasUseStrict(root.data.source_file.stmts));
    f.scope.global = true;
    r.res.script = f;
    try r.hoist(f.scope, root.data.source_file.stmts, true);
    try r.stmts(f.scope, root.data.source_file.stmts);
    return r.res;
}

/// A directive prologue that holds `"use strict"`.
pub fn hasUseStrict(body: []const *Node) bool {
    for (body) |s| {
        if (s.data != .expr_stmt or s.data.expr_stmt.expr.data != .string_lit) return false;
        const e = s.data.expr_stmt.expr;
        // The raw text, so an escaped `"use\x20strict"` is not the directive.
        if (e.end - e.start == "'use strict'".len and std.mem.eql(u8, e.data.string_lit, "use strict")) return true;
    }
    return false;
}

const Resolver = struct {
    a: Allocator,
    res: Resolution,

    fn newScope(r: *Resolver, parent: ?*Scope, f: *Function) !*Scope {
        const s = try r.a.create(Scope);
        s.* = .{ .parent = parent, .func = f };
        try f.scopes.append(r.a, s);
        return s;
    }

    fn newFunction(r: *Resolver, node: ?*Node, parent_scope: ?*Scope, arrow: bool, strict: bool) !*Function {
        const f = try r.a.create(Function);
        f.* = .{ .node = node, .scope = undefined, .parent = if (parent_scope) |p| p.func else null, .arrow = arrow, .strict = strict };
        f.scope = try r.newScope(parent_scope, f);
        if (node) |n| try r.res.functions.put(r.a, n, f);
        return f;
    }

    fn declare(r: *Resolver, s: *Scope, name: []const u8, kind: Kind) !*Binding {
        if (s.bindings.get(name)) |b| {
            // A later `function` declaration of a `var`'s name wins; a parameter keeps its slot.
            if (kind == .function and b.kind == .@"var") b.kind = .function;
            return b;
        }
        const b = try r.a.create(Binding);
        b.* = .{ .name = name, .kind = kind, .scope = s };
        try s.bindings.put(r.a, name, b);
        return b;
    }

    /// Declares every name a binding pattern introduces.
    fn declarePattern(r: *Resolver, s: *Scope, pat: *Node, kind: Kind) Allocator.Error!void {
        switch (pat.data) {
            .identifier => |name| _ = try r.declare(s, name, kind),
            .object_pattern => |p| for (p.elems) |e| try r.declarePattern(s, e, kind),
            .array_pattern => |p| for (p.elems) |e| try r.declarePattern(s, e, kind),
            .binding_elem => |e| try r.declarePattern(s, e.name, kind),
            else => {},
        }
    }

    /// The function-scoped declarations of `body` (ECMA-262 VarDeclaredNames, through nested
    /// statements but not nested functions), then the lexical declarations of `body` itself.
    fn hoist(r: *Resolver, s: *Scope, body: []const *Node, top: bool) !void {
        const fs = s.func.scope;
        for (body) |st| try r.hoistVars(fs, st);
        for (body) |st| try r.hoistLexical(s, st, top);
    }

    fn hoistVars(r: *Resolver, fs: *Scope, st: *Node) Allocator.Error!void {
        switch (st.data) {
            .var_stmt => |v| try r.hoistVarList(fs, v.list),
            .if_stmt => |x| {
                try r.hoistVars(fs, x.then);
                if (x.els) |e| try r.hoistVars(fs, e);
            },
            .do_stmt => |x| try r.hoistVars(fs, x.body),
            .while_stmt => |x| try r.hoistVars(fs, x.body),
            .for_stmt => |x| {
                if (x.init) |i| if (i.data == .var_list) try r.hoistVarList(fs, i);
                try r.hoistVars(fs, x.body);
            },
            inline .for_in, .for_of => |x| {
                if (x.init.data == .var_list) try r.hoistVarList(fs, x.init);
                try r.hoistVars(fs, x.body);
            },
            .block => |b| for (b.stmts) |x| try r.hoistVars(fs, x),
            .labeled => |l| try r.hoistVars(fs, l.stmt),
            .try_stmt => |t| {
                try r.hoistVars(fs, t.block);
                if (t.catch_clause) |cc| try r.hoistVars(fs, cc.data.catch_clause.block);
                if (t.finally) |f| try r.hoistVars(fs, f);
            },
            .switch_stmt => |sw| for (sw.clauses) |cl| switch (cl.data) {
                .case_clause => |cc| for (cc.stmts) |x| try r.hoistVars(fs, x),
                .default_clause => |dc| for (dc.stmts) |x| try r.hoistVars(fs, x),
                else => {},
            },
            .with_stmt => |w| try r.hoistVars(fs, w.body),
            else => {},
        }
    }

    fn hoistVarList(r: *Resolver, fs: *Scope, list: *Node) !void {
        const l = list.data.var_list;
        if (l.kind != .@"var") return;
        for (l.decls) |d| try r.declarePattern(fs, d.data.var_decl.name, .@"var");
    }

    fn hoistLexical(r: *Resolver, s: *Scope, st: *Node, top: bool) !void {
        switch (st.data) {
            .var_stmt => |v| {
                const l = v.list.data.var_list;
                const kind: Kind = switch (l.kind) {
                    .@"var" => return,
                    .let => .let,
                    else => .@"const",
                };
                for (l.decls) |d| try r.declarePattern(s, d.data.var_decl.name, kind);
            },
            .func => |f| if (f.name) |n| {
                // A function at the top of a function body or a script is var-scoped; one in a
                // block is the block's (ECMA-262 §14.2.2, without Annex B's var copy).
                _ = try r.declare(if (top) s.func.scope else s, n.data.identifier, .function);
            },
            .class => |c| if (c.name) |n| {
                _ = try r.declare(s, n.data.identifier, .class);
            },
            .labeled => |l| try r.hoistLexical(s, l.stmt, top),
            else => {},
        }
    }

    fn reference(r: *Resolver, s: *Scope, node: *Node, name: []const u8) !void {
        const b = s.lookup(name) orelse blk: {
            if (!std.mem.eql(u8, name, "arguments")) return;
            // `arguments` belongs to the nearest non-arrow function, made when something reads it.
            const f = nonArrow(s.func) orelse return;
            break :blk try r.declare(f.scope, "arguments", .arguments);
        };
        if (b.scope.global) return;
        try r.bind(s, node, b);
    }

    fn bind(r: *Resolver, s: *Scope, node: *Node, b: *Binding) !void {
        if (b.scope.func != s.func) b.captured = true;
        try r.res.refs.put(r.a, node, b);
    }

    fn nonArrow(f: *Function) ?*Function {
        var cur: ?*Function = f;
        while (cur) |x| : (cur = x.parent) {
            if (!x.arrow) return if (x.node == null) null else x;
        }
        return null;
    }

    fn this(r: *Resolver, s: *Scope, node: *Node) !void {
        const f = nonArrow(s.func) orelse return;
        try r.bind(s, node, try r.declare(f.scope, "this", .this));
    }

    fn stmts(r: *Resolver, s: *Scope, list: []const *Node) Allocator.Error!void {
        for (list) |st| try r.walk(s, st);
    }

    /// A new block scope inside `s`, recorded as the scope `n` opens.
    fn scopeOf(r: *Resolver, s: *Scope, n: *Node) !*Scope {
        const inner = try r.newScope(s, s.func);
        try r.res.scopes.put(r.a, n, inner);
        return inner;
    }

    fn block(r: *Resolver, s: *Scope, n: *Node, list: []const *Node) !void {
        const inner = try r.scopeOf(s, n);
        try r.hoist(inner, list, false);
        try r.stmts(inner, list);
    }

    fn function(r: *Resolver, s: *Scope, n: *Node, f: *Func) !void {
        const arrow = f.kind == .arrow;
        const body_stmts: []const *Node = if (f.body) |b| switch (b.data) {
            .block => |blk| blk.stmts,
            else => &.{},
        } else &.{};
        var outer = s;
        var name_scope: ?*Scope = null;
        if (f.kind == .expr) if (f.name) |name| {
            // A named function expression sees its own name in a scope of its own, between the
            // enclosing one and its parameters (ECMA-262 §15.2.5).
            const fn_info = try r.newFunction(null, s, false, false);
            name_scope = fn_info.scope;
            _ = try r.declare(fn_info.scope, name.data.identifier, .callee);
            outer = fn_info.scope;
        };
        const strict = s.func.strict or hasUseStrict(body_stmts) or isClassMember(n);
        const fi = try r.newFunction(n, outer, arrow, strict);
        if (name_scope) |ns| {
            // The name's scope belongs to the function it names, so a read of it from the body
            // is not a capture.
            ns.func = fi;
            fi.name_scope = ns;
            fi.parent = s.func;
            try fi.scopes.insert(r.a, 0, ns);
        }
        for (f.params) |p| try r.declarePattern(fi.scope, p.data.param.name, .param);
        for (f.params) |p| {
            const param = p.data.param;
            try r.pattern(fi.scope, param.name);
            if (param.init) |i| try r.walk(fi.scope, i);
        }
        if (f.body) |b| switch (b.data) {
            .block => |blk| {
                try r.res.scopes.put(r.a, b, fi.scope);
                try r.hoist(fi.scope, blk.stmts, true);
                try r.stmts(fi.scope, blk.stmts);
            },
            else => try r.walk(fi.scope, b),
        };
    }

    fn isClassMember(n: *Node) bool {
        const p = n.parent orelse return false;
        return p.data == .class;
    }

    /// The references a binding pattern makes: its default values and computed keys, and the
    /// names it binds, which resolve to their own declarations.
    fn pattern(r: *Resolver, s: *Scope, pat: *Node) Allocator.Error!void {
        switch (pat.data) {
            .identifier => |name| try r.reference(s, pat, name),
            .object_pattern => |p| for (p.elems) |e| try r.pattern(s, e),
            .array_pattern => |p| for (p.elems) |e| try r.pattern(s, e),
            .binding_elem => |e| {
                if (e.prop_name) |pn| if (pn.data == .computed_name) try r.walk(s, pn.data.computed_name.expr);
                try r.pattern(s, e.name);
                if (e.init) |i| try r.walk(s, i);
            },
            else => {},
        }
    }

    fn walk(r: *Resolver, s: *Scope, n: *Node) Allocator.Error!void {
        switch (n.data) {
            .identifier => |name| try r.reference(s, n, name),
            .this_expr => try r.this(s, n),
            .func => |f| try r.function(s, n, f),
            .block => |b| try r.block(s, n, b.stmts),
            .var_decl => |d| {
                try r.pattern(s, d.name);
                if (d.init) |i| try r.walk(s, i);
            },
            .for_stmt => |f| {
                const inner = try r.scopeOf(s, n);
                if (f.init) |i| {
                    if (i.data == .var_list) try r.hoistLoopHead(inner, i);
                    try r.walk(inner, i);
                }
                if (f.cond) |x| try r.walk(inner, x);
                if (f.update) |x| try r.walk(inner, x);
                try r.walk(inner, f.body);
            },
            .for_in => |f| try r.loopIn(s, n, f.init, f.expr, f.body),
            .for_of => |f| try r.loopIn(s, n, f.init, f.expr, f.body),
            .catch_clause => |cc| {
                const inner = try r.scopeOf(s, n);
                if (cc.decl) |d| {
                    try r.declarePattern(inner, d.data.var_decl.name, .catch_param);
                    try r.pattern(inner, d.data.var_decl.name);
                }
                try r.walk(inner, cc.block);
            },
            .switch_stmt => |sw| {
                try r.walk(s, sw.expr);
                const inner = try r.scopeOf(s, n);
                for (sw.clauses) |cl| switch (cl.data) {
                    .case_clause => |cc| try r.hoist(inner, cc.stmts, false),
                    .default_clause => |dc| try r.hoist(inner, dc.stmts, false),
                    else => {},
                };
                for (sw.clauses) |cl| try r.walk(inner, cl);
            },
            .class => |c| {
                var inner = s;
                if (c.name) |name| {
                    // The class's own name, read-only inside its body (ECMA-262 §15.7.14).
                    inner = try r.scopeOf(s, n);
                    // The compiler finds both this binding and the declaration's by name.
                    _ = try r.declare(inner, name.data.identifier, .@"const");
                }
                for (c.heritage) |h| try r.walk(inner, h);
                for (c.members) |m| try r.member(inner, m);
            },
            .object_lit => |o| for (o.props) |p| {
                if (p.data == .func) try r.member(s, p) else try r.walk(s, p);
            },
            // Names that are not references.
            .prop_access => |p| try r.walk(s, p.expr),
            .property_assign => |p| {
                if (p.name.data == .computed_name) try r.walk(s, p.name);
                try r.walk(s, p.value);
            },
            .shorthand_assign => |p| {
                try r.reference(s, p.name, p.name.data.identifier);
                if (p.init) |i| try r.walk(s, i);
            },
            .labeled => |l| try r.walk(s, l.stmt),
            .break_stmt, .continue_stmt, .meta_property => {},
            else => ast.forEachChild(n, Ctx{ .r = r, .s = s }, visit),
        }
    }

    fn member(r: *Resolver, s: *Scope, m: *Node) !void {
        switch (m.data) {
            .func => |f| {
                if (f.name) |name| if (name.data == .computed_name) try r.walk(s, name);
                try r.function(s, m, f);
            },
            .property_decl => |p| {
                if (p.name.data == .computed_name) try r.walk(s, p.name);
                // A field initializer runs as a method of the instance: `this` is the instance.
                if (p.init) |i| {
                    const fi = try r.newFunction(m, s, false, true);
                    try r.walk(fi.scope, i);
                }
            },
            .static_block => |b| {
                const fi = try r.newFunction(m, s, false, true);
                try r.res.scopes.put(r.a, b.body, fi.scope);
                try r.hoist(fi.scope, b.body.data.block.stmts, true);
                try r.stmts(fi.scope, b.body.data.block.stmts);
            },
            else => {},
        }
    }

    /// `for (let …;;)`: the head's lexical declarations are the loop scope's.
    fn hoistLoopHead(r: *Resolver, s: *Scope, list: *Node) !void {
        const l = list.data.var_list;
        const kind: Kind = switch (l.kind) {
            .@"var" => return,
            .let => .let,
            else => .@"const",
        };
        for (l.decls) |d| try r.declarePattern(s, d.data.var_decl.name, kind);
    }

    fn loopIn(r: *Resolver, s: *Scope, n: *Node, init: *Node, expr: *Node, body: *Node) !void {
        // The object is evaluated with the head's names in their TDZ (ECMA-262 §14.7.5.6), so it
        // resolves in the loop scope too.
        const inner = try r.scopeOf(s, n);
        if (init.data == .var_list) try r.hoistLoopHead(inner, init);
        try r.walk(inner, expr);
        try r.walk(inner, init);
        try r.walk(inner, body);
    }

    const Ctx = struct { r: *Resolver, s: *Scope };

    fn visit(ctx: Ctx, child: *Node) void {
        ctx.r.walk(ctx.s, child) catch @panic("out of memory");
    }
};
