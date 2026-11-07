//! The bytecode compiler (docs/INTERPRETER.md §2): stator-ts's tree, resolved by `scope.zig`, to
//! one `Proto` per function. Statements leave the operand stack empty, so every statement starts
//! at depth zero, and loop and `switch` state sits in registers rather than on the stack: a jump
//! out of any of them needs no stack repair.

const std = @import("std");
const Allocator = std.mem.Allocator;
const c = @import("jsrt");
const jstext = @import("jstext");
const bc = @import("bytecode.zig");
const gc = @import("gc.zig");
const parse = @import("parse.zig");
const scope = @import("scope.zig");

const ast = parse.ast;
const Node = ast.Node;
const Tok = ast.Tok;
const Op = bc.Op;
const Value = bc.Value;
const Binding = scope.Binding;
const Scope = scope.Scope;

pub const Error = error{ OutOfMemory, Unsupported };

/// A construct this slice does not compile yet, where compilation stopped.
pub const Unsupported = struct { offset: u32, what: []const u8 };

pub const Compiler = struct {
    a: Allocator,
    res: *const scope.Resolution,
    unsupported: ?Unsupported = null,

    fn fail(comp: *Compiler, n: *const Node, what: []const u8) Error {
        comp.unsupported = .{ .offset = n.start, .what = what };
        return error.Unsupported;
    }
};

pub fn compileScript(comp: *Compiler, root: *Node) Error!*bc.Proto {
    const info = comp.res.script;
    var f: Fn = .{ .comp = comp, .parent = null, .info = info, .strict = info.strict };
    const stmts = root.data.source_file.stmts;
    const completion = f.allocReg();
    f.completion = completion;
    try f.emit0(.push_undef);
    try f.emit1(.set_loc, completion);
    // ECMA-262 GlobalDeclarationInstantiation: lexical names, then functions, then vars.
    for (info.scope.bindings.values()) |b| switch (b.kind) {
        .let, .class => try f.emit1(.def_global_lex, try f.name(b.name)),
        .@"const" => try f.emit1(.def_global_const, try f.name(b.name)),
        else => {},
    };
    try f.hoistFunctions(info.scope, stmts);
    for (info.scope.bindings.values()) |b| {
        if (b.kind == .@"var") try f.emit1(.def_global_var, try f.name(b.name));
    }
    try f.stmts(stmts);
    try f.emit1(.get_loc, completion);
    try f.emit0(.@"return");
    return f.finish("", 0, .{ .strict = info.strict });
}

const Label = struct {
    pos: ?u32 = null,
    depth: ?u32 = null,
    refs: std.ArrayList(u32) = .empty,
};

/// What a `break`, `continue` or `return` passes on its way out.
const Ctl = struct {
    kind: enum { loop, breakable, env, finally },
    /// The labels a loop or a labelled statement carries.
    labels: []const []const u8 = &.{},
    /// A loop or a `switch`, which an unlabelled `break` targets; a labelled block is not.
    unlabeled: bool = false,
    brk: u32 = 0,
    cont: u32 = 0,
    /// A `for-of`'s iterator register, closed by a jump out of the loop.
    iter: ?u16 = null,
    /// A `finally`'s completion registers and its entry.
    rtype: u16 = 0,
    rval: u16 = 0,
    entry: u32 = 0,
};

/// A protected range whose handler is bound later.
const Region = struct { start: u32, end: u32 };

const Short = struct { label: u32, depth: u32 };

const Fn = struct {
    comp: *Compiler,
    parent: ?*Fn,
    info: *scope.Function,
    strict: bool,
    code: std.ArrayList(u8) = .empty,
    /// Collected memory: the strings in it are reachable from nothing else until `finish`.
    consts: std.ArrayList(Value) = .empty,
    const_strings: std.StringHashMapUnmanaged(u16) = .empty,
    names: std.ArrayList([*:0]const u8) = .empty,
    name_index: std.AutoHashMapUnmanaged([*:0]const u8, u16) = .empty,
    /// Collected memory, for the same reason as `consts`.
    protos: std.ArrayList(*bc.Proto) = .empty,
    nics: u16 = 0,
    handlers: std.ArrayList(bc.Handler) = .empty,
    labels: std.ArrayList(Label) = .empty,
    ctl: std.ArrayList(Ctl) = .empty,
    /// The scopes that hold an environment right now, innermost last.
    envs: std.ArrayList(*Scope) = .empty,
    next_reg: u16 = 0,
    max_reg: u16 = 0,
    depth: u32 = 0,
    max_depth: u32 = 0,
    /// A script's completion value.
    completion: ?u16 = null,
    /// The return value while a `return` runs the `finally` blocks it leaves.
    ret_reg: ?u16 = null,

    // ---------------------------------------------------------------- emission

    fn adjust(f: *Fn, d: i32) void {
        f.depth = @intCast(@as(i32, @intCast(f.depth)) + d);
        f.max_depth = @max(f.max_depth, f.depth);
    }

    fn byte(f: *Fn, b: u8) !void {
        try f.code.append(f.comp.a, b);
    }

    fn word(f: *Fn, v: u16) !void {
        try f.code.appendSlice(f.comp.a, &std.mem.toBytes(std.mem.nativeToLittle(u16, v)));
    }

    fn emit0(f: *Fn, op: Op) !void {
        try f.byte(@backingInt(op));
        f.adjust(bc.stackEffect(op, 0));
    }

    fn emit1(f: *Fn, op: Op, x: u16) !void {
        try f.byte(@backingInt(op));
        try f.word(x);
        f.adjust(bc.stackEffect(op, x));
    }

    fn emit2(f: *Fn, op: Op, x: u16, y: u16) !void {
        try f.byte(@backingInt(op));
        try f.word(x);
        try f.word(y);
        f.adjust(bc.stackEffect(op, 0));
    }

    fn emit3(f: *Fn, op: Op, x: u16, y: u16, z: u16) !void {
        try f.emit2(op, x, y);
        try f.word(z);
    }

    fn emitArgc(f: *Fn, op: Op, n: *const Node, argc: usize) !void {
        if (argc > std.math.maxInt(u8)) return f.comp.fail(n, "a call with more than 255 arguments");
        try f.byte(@backingInt(op));
        try f.byte(@intCast(argc));
        f.adjust(bc.stackEffect(op, @intCast(argc)));
    }

    fn newLabel(f: *Fn) !u32 {
        try f.labels.append(f.comp.a, .{});
        return @intCast(f.labels.items.len - 1);
    }

    fn newLabels(f: *Fn, comptime n: usize) ![n]u32 {
        var out: [n]u32 = undefined;
        for (&out) |*l| l.* = try f.newLabel();
        return out;
    }

    fn patch(f: *Fn, at: u32, target: u32) void {
        const off: i32 = @as(i32, @intCast(target)) - @as(i32, @intCast(at + 4));
        std.mem.writeInt(i32, f.code.items[at..][0..4], off, .little);
    }

    /// The offset operand of a jump to `l`, which ends the instruction.
    fn ref(f: *Fn, l: u32, depth: u32) !void {
        const at: u32 = @intCast(f.code.items.len);
        try f.code.appendNTimes(f.comp.a, 0, 4);
        const label = &f.labels.items[l];
        if (label.depth == null) label.depth = depth;
        if (label.pos) |p| f.patch(at, p) else try label.refs.append(f.comp.a, at);
    }

    fn jump(f: *Fn, op: Op, l: u32) !void {
        try f.byte(@backingInt(op));
        f.adjust(bc.stackEffect(op, 0));
        try f.ref(l, f.depth);
    }

    /// `for_in_next` and `for_of_next`: the jump leaves the stack as it was; falling through pushes.
    fn regJump(f: *Fn, op: Op, r: u16, l: u32) !void {
        try f.byte(@backingInt(op));
        try f.word(r);
        try f.ref(l, f.depth);
        f.adjust(bc.stackEffect(op, 0));
    }

    fn bind(f: *Fn, l: u32) void {
        const label = &f.labels.items[l];
        const here: u32 = @intCast(f.code.items.len);
        label.pos = here;
        for (label.refs.items) |at| f.patch(at, here);
        if (label.depth) |d| f.depth = d else label.depth = f.depth;
    }

    fn pos(f: *const Fn) u32 {
        return @intCast(f.code.items.len);
    }

    fn allocReg(f: *Fn) u16 {
        const r = f.next_reg;
        f.next_reg += 1;
        f.max_reg = @max(f.max_reg, f.next_reg);
        return r;
    }

    fn name(f: *Fn, bytes: []const u8) !u16 {
        const key = intern(bytes);
        const gop = try f.name_index.getOrPut(f.comp.a, key);
        if (!gop.found_existing) {
            gop.value_ptr.* = @intCast(f.names.items.len);
            try f.names.append(f.comp.a, key);
        }
        return gop.value_ptr.*;
    }

    fn constValue(f: *Fn, v: Value) !u16 {
        try f.consts.append(gc.allocator, v);
        return @intCast(f.consts.items.len - 1);
    }

    fn constNum(f: *Fn, x: f64) !u16 {
        return f.constValue(c.jsrt_number(x));
    }

    fn constStr(f: *Fn, s: []const u8) !u16 {
        const gop = try f.const_strings.getOrPut(f.comp.a, s);
        if (!gop.found_existing) gop.value_ptr.* = try f.constValue(c.jsrt_string_from_utf8(s.ptr, s.len));
        return gop.value_ptr.*;
    }

    fn pushNum(f: *Fn, x: f64) !void {
        try f.emit1(.push_const, try f.constNum(x));
    }

    fn ic(f: *Fn) u16 {
        defer f.nics += 1;
        return f.nics;
    }

    fn finish(f: *Fn, fn_name: []const u8, arity: u32, flags: bc.Flags) !*bc.Proto {
        const proto: *bc.Proto = try gc.allocator.create(bc.Proto);
        proto.* = .{
            .code = gc.dupe(u8, f.code.items),
            .consts = f.consts.items,
            .names = gc.dupe([*:0]const u8, f.names.items),
            .protos = f.protos.items,
            .ics = gc.dupe(c.JSRTIC, &.{}),
            .handlers = gc.dupe(bc.Handler, f.handlers.items),
            .name = intern(fn_name),
            .arity = arity,
            .nregs = f.max_reg,
            .max_stack = f.max_depth,
            .flags = flags,
        };
        const ics = try gc.allocator.alloc(c.JSRTIC, f.nics);
        @memset(ics, .{});
        proto.ics = ics;
        return proto;
    }

    // ---------------------------------------------------------------- bindings

    /// How many environments lie between the code being compiled and `s`'s.
    fn envDepth(f: *Fn, s: *const Scope) u16 {
        var d: u16 = 0;
        var cur: ?*Fn = f;
        while (cur) |x| : (cur = x.parent) {
            var i = x.envs.items.len;
            while (i > 0) {
                i -= 1;
                if (x.envs.items[i] == s) return d;
                d += 1;
            }
            // The closure's own environment, which holds its template and itself (vm.zig).
            d += 1;
        }
        unreachable;
    }

    fn load(f: *Fn, b: *const Binding) !void {
        const tdz = b.kind.hasTdz();
        if (b.captured) {
            const d = f.envDepth(b.scope);
            if (tdz) try f.emit3(.get_env_chk, d, b.slot, try f.name(b.name)) else try f.emit2(.get_env, d, b.slot);
        } else {
            if (tdz) try f.emit2(.get_loc_chk, b.slot, try f.name(b.name)) else try f.emit1(.get_loc, b.slot);
        }
    }

    /// A declaration's store, which neither checks the TDZ nor refuses a `const`: [v] → [].
    fn storeInit(f: *Fn, b: *const Binding) !void {
        if (b.scope.global) {
            const n = try f.name(b.name);
            switch (b.kind) {
                .function => try f.emit1(.def_global_func, n),
                .let, .@"const", .class => try f.emit1(.init_global_lex, n),
                else => {
                    try f.emit1(.put_global, n);
                    try f.emit0(.pop);
                },
            }
        } else if (b.captured) {
            try f.emit2(.set_env, f.envDepth(b.scope), b.slot);
        } else {
            try f.emit1(.set_loc, b.slot);
        }
    }

    /// An assignment's store: [v] → [v], or [v] → [] unless `keep`.
    fn storeAssign(f: *Fn, b: *const Binding, keep: bool) !void {
        if (b.kind == .callee) {
            // A named function expression's own name is immutable; sloppy code ignores the write.
            if (f.strict) return f.emit0(.throw_const);
        } else {
            if (b.kind.hasTdz()) {
                const n = try f.name(b.name);
                if (b.captured) try f.emit3(.chk_env, f.envDepth(b.scope), b.slot, n) else try f.emit2(.chk_loc, b.slot, n);
            }
            if (b.kind == .@"const") return f.emit0(.throw_const);
            if (b.captured) {
                try f.emit2(.put_env, f.envDepth(b.scope), b.slot);
            } else {
                try f.emit1(.put_loc, b.slot);
            }
        }
        if (!keep) try f.emit0(.pop);
    }

    fn identLoad(f: *Fn, n: *const Node) !void {
        if (f.comp.res.refs.get(n)) |b| return f.load(b);
        const id = n.data.identifier;
        if (std.mem.eql(u8, id, "undefined")) return f.emit0(.push_undef);
        try f.emit1(.get_global, try f.name(id));
    }

    fn identStore(f: *Fn, n: *const Node, keep: bool) !void {
        if (f.comp.res.refs.get(n)) |b| return f.storeAssign(b, keep);
        try f.emit1(.put_global, try f.name(n.data.identifier));
        if (!keep) try f.emit0(.pop);
    }

    /// Gives a scope's bindings their registers and environment slots, pushes its environment
    /// when anything captures one, and puts its TDZ bindings in their dead zone.
    fn enterScope(f: *Fn, s: *Scope) !void {
        if (s.global) return;
        var nenv: u16 = 0;
        for (s.bindings.values()) |b| {
            if (b.captured) {
                b.slot = nenv;
                nenv += 1;
            } else {
                b.slot = f.allocReg();
            }
        }
        s.env_slots = nenv;
        if (nenv > 0) {
            try f.emit1(.push_scope, nenv);
            try f.envs.append(f.comp.a, s);
            try f.ctl.append(f.comp.a, .{ .kind = .env });
        }
        for (s.bindings.values()) |b| {
            if (!b.kind.hasTdz()) continue;
            try f.emit0(.push_hole);
            try f.storeInit(b);
        }
    }

    fn leaveScope(f: *Fn, s: *Scope, mark: u16) !void {
        if (s.hasEnv()) {
            try f.emit0(.pop_scope);
            _ = f.envs.pop();
            _ = f.ctl.pop();
        }
        f.next_reg = mark;
    }

    /// The function declarations among `body`, created as its scope opens (ECMA-262 §10.2.11).
    fn hoistFunctions(f: *Fn, s: *Scope, body: []const *Node) !void {
        for (body) |st| {
            var n = st;
            while (n.data == .labeled) n = n.data.labeled.stmt;
            if (n.data != .func or n.data.func.kind != .decl) continue;
            const id = (n.data.func.name orelse continue).data.identifier;
            try f.closure(n, id);
            try f.storeInit(s.lookup(id) orelse unreachable);
        }
    }

    // ---------------------------------------------------------------- functions

    fn closure(f: *Fn, n: *Node, hint: ?[]const u8) Error!void {
        const proto = try compileFunction(f.comp, f, n, hint orelse "");
        try f.protos.append(gc.allocator, proto);
        try f.emit1(.closure, @intCast(f.protos.items.len - 1));
    }

    // ---------------------------------------------------------------- statements

    fn stmts(f: *Fn, list: []const *Node) Error!void {
        for (list) |st| try f.stmt(st, &.{});
    }

    fn stmt(f: *Fn, n: *Node, labels: []const []const u8) Error!void {
        std.debug.assert(f.depth == 0);
        switch (n.data) {
            .expr_stmt => |e| {
                try f.expr(e.expr);
                if (f.completion) |r| try f.emit1(.set_loc, r) else try f.emit0(.pop);
            },
            .var_stmt => |v| try f.varList(v.list),
            .func => |fd| if (fd.kind != .decl) return f.comp.fail(n, "a function at statement position"),
            .block => |b| try f.block(n, b.stmts),
            .empty_stmt, .debugger_stmt => {},
            .if_stmt => |s| {
                const els = try f.newLabel();
                try f.expr(s.cond);
                try f.jump(.jmp_false, els);
                try f.stmt(s.then, &.{});
                if (s.els) |e| {
                    const end = try f.newLabel();
                    try f.jump(.jmp, end);
                    f.bind(els);
                    try f.stmt(e, &.{});
                    f.bind(end);
                } else f.bind(els);
            },
            .while_stmt => |s| {
                const top, const brk = try f.newLabels(2);
                f.bind(top);
                try f.expr(s.cond);
                try f.jump(.jmp_false, brk);
                try f.loopBody(s.body, labels, brk, top, null);
                try f.jump(.jmp, top);
                f.bind(brk);
            },
            .do_stmt => |s| {
                const top, const cont, const brk = try f.newLabels(3);
                f.bind(top);
                try f.loopBody(s.body, labels, brk, cont, null);
                f.bind(cont);
                try f.expr(s.cond);
                try f.jump(.jmp_true, top);
                f.bind(brk);
            },
            .for_stmt => |s| try f.forStmt(n, s, labels),
            .for_in => |s| try f.forInOf(n, s.init, s.expr, s.body, labels, false),
            .for_of => |s| {
                if (s.is_await) return f.comp.fail(n, "for await");
                try f.forInOf(n, s.init, s.expr, s.body, labels, true);
            },
            .labeled => |l| {
                var all: std.ArrayList([]const u8) = .empty;
                try all.appendSlice(f.comp.a, labels);
                try all.append(f.comp.a, l.label.data.identifier);
                switch (l.stmt.data) {
                    .while_stmt, .do_stmt, .for_stmt, .for_in, .for_of, .labeled => try f.stmt(l.stmt, all.items),
                    else => {
                        const brk = try f.newLabel();
                        try f.ctl.append(f.comp.a, .{ .kind = .breakable, .labels = all.items, .brk = brk });
                        try f.stmt(l.stmt, &.{});
                        _ = f.ctl.pop();
                        f.bind(brk);
                    },
                }
            },
            .break_stmt => |b| try f.jumpOut(n, if (b.label) |l| l.data.identifier else null, false),
            .continue_stmt => |b| try f.jumpOut(n, if (b.label) |l| l.data.identifier else null, true),
            .return_stmt => |r| {
                if (r.expr) |e| try f.expr(e) else try f.emit0(.push_undef);
                try f.returnTop();
            },
            .throw_stmt => |t| {
                try f.expr(t.expr);
                try f.emit0(.throw);
                f.depth = 0;
            },
            .try_stmt => |t| try f.tryStmt(t.block, t.catch_clause, t.finally),
            .switch_stmt => |s| try f.switchStmt(n, s.expr, s.clauses, labels),
            .class => return f.comp.fail(n, "a class"),
            .with_stmt => return f.comp.fail(n, "a with statement"),
            else => return f.comp.fail(n, @tagName(n.data)),
        }
    }

    fn block(f: *Fn, n: *const Node, list: []const *Node) !void {
        const s = f.comp.res.scopes.get(n) orelse unreachable;
        const mark = f.next_reg;
        try f.enterScope(s);
        try f.hoistFunctions(s, list);
        try f.stmts(list);
        try f.leaveScope(s, mark);
    }

    fn varList(f: *Fn, list: *const Node) !void {
        const l = list.data.var_list;
        for (l.decls) |d| {
            const decl = d.data.var_decl;
            if (decl.name.data != .identifier) return f.comp.fail(decl.name, "a destructuring declaration");
            // `var x;` leaves x as it is; `let x;` initializes it.
            if (decl.init == null and l.kind == .@"var") continue;
            if (decl.init) |i| try f.exprNamed(i, decl.name.data.identifier) else try f.emit0(.push_undef);
            try f.declStore(list, decl.name);
        }
    }

    /// Stores the value on the stack into a name a declaration list declares: [v] → [].
    fn declStore(f: *Fn, list: *const Node, id: *const Node) !void {
        switch (list.data.var_list.kind) {
            .@"var" => try f.identStore(id, false),
            .let, .@"const" => try f.declInit(id),
            else => return f.comp.fail(list, "a using declaration"),
        }
    }

    /// The store of a lexical declaration's value: [v] → [].
    fn declInit(f: *Fn, id: *const Node) !void {
        if (f.comp.res.refs.get(id)) |b| return f.storeInit(b);
        try f.emit1(.init_global_lex, try f.name(id.data.identifier));
    }

    fn loopBody(f: *Fn, body: *Node, labels: []const []const u8, brk: u32, cont: u32, iter: ?u16) !void {
        try f.ctl.append(f.comp.a, .{ .kind = .loop, .labels = labels, .unlabeled = true, .brk = brk, .cont = cont, .iter = iter });
        try f.stmt(body, &.{});
        _ = f.ctl.pop();
    }

    fn forStmt(f: *Fn, n: *const Node, s: *const ast.ForStmt, labels: []const []const u8) !void {
        const sc = f.comp.res.scopes.get(n) orelse unreachable;
        const mark = f.next_reg;
        try f.enterScope(sc);
        // A closure in the body sees its own iteration's `let` (CreatePerIterationEnvironment).
        var per_iteration = false;
        if (s.init) |i| {
            if (i.data == .var_list) {
                try f.varList(i);
                per_iteration = sc.hasEnv() and i.data.var_list.kind != .@"var";
            } else {
                try f.expr(i);
                try f.emit0(.pop);
            }
        }
        if (per_iteration) try f.emit0(.clone_scope);
        const top, const cont, const brk = try f.newLabels(3);
        f.bind(top);
        if (s.cond) |x| {
            try f.expr(x);
            try f.jump(.jmp_false, brk);
        }
        try f.loopBody(s.body, labels, brk, cont, null);
        f.bind(cont);
        if (per_iteration) try f.emit0(.clone_scope);
        if (s.update) |x| {
            try f.expr(x);
            try f.emit0(.pop);
        }
        try f.jump(.jmp, top);
        f.bind(brk);
        try f.leaveScope(sc, mark);
    }

    fn forInOf(f: *Fn, n: *const Node, init: *Node, obj: *Node, body: *Node, labels: []const []const u8, of: bool) !void {
        const sc = f.comp.res.scopes.get(n) orelse unreachable;
        const mark = f.next_reg;
        try f.enterScope(sc);
        try f.expr(obj);
        const r = f.allocReg();
        if (!of) {
            _ = f.allocReg();
            _ = f.allocReg();
        }
        try f.emit1(if (of) .for_of_start else .for_in_start, r);
        const next, const brk = try f.newLabels(2);
        f.bind(next);
        try f.regJump(if (of) .for_of_next else .for_in_next, r, brk);
        if (init.data == .var_list) {
            const l = init.data.var_list;
            if (l.decls.len != 1) return f.comp.fail(init, "a for-in/of head with more than one binding");
            const decl = l.decls[0].data.var_decl;
            if (decl.name.data != .identifier) return f.comp.fail(decl.name, "a destructuring declaration");
            if (decl.init != null) return f.comp.fail(init, "a for-in head initializer");
            if (l.kind != .@"var" and sc.hasEnv()) try f.emit0(.clone_scope);
            try f.declStore(init, decl.name);
        } else {
            try f.assignTo(init);
        }
        try f.loopBody(body, labels, brk, next, if (of) r else null);
        try f.jump(.jmp, next);
        f.bind(brk);
        try f.leaveScope(sc, mark);
    }

    /// Stores the value on the stack into an assignment target, popping it.
    fn assignTo(f: *Fn, target: *Node) !void {
        const t = unparen(target);
        switch (t.data) {
            .identifier => try f.identStore(t, false),
            .prop_access, .elem_access => {
                const tmp = f.allocReg();
                try f.emit1(.set_loc, tmp);
                if (t.data == .prop_access) {
                    const p = t.data.prop_access;
                    try f.expr(p.expr);
                    try f.emit1(.get_loc, tmp);
                    try f.emit2(.put_field, try f.name(p.name.data.identifier), f.ic());
                } else {
                    const e = t.data.elem_access;
                    try f.expr(e.expr);
                    try f.expr(e.index);
                    try f.emit1(.get_loc, tmp);
                    try f.emit1(.put_elem, f.ic());
                }
                try f.emit0(.pop);
                f.next_reg = tmp;
            },
            else => return f.comp.fail(t, "a destructuring assignment"),
        }
    }

    fn switchStmt(f: *Fn, n: *const Node, disc: *Node, clauses: []const *Node, labels: []const []const u8) !void {
        const mark = f.next_reg;
        try f.expr(disc);
        const r = f.allocReg();
        try f.emit1(.set_loc, r);
        const sc = f.comp.res.scopes.get(n) orelse unreachable;
        try f.enterScope(sc);
        for (clauses) |cl| try f.hoistFunctions(sc, clauseStmts(cl));
        const bodies = try f.comp.a.alloc(u32, clauses.len);
        var default: ?u32 = null;
        for (clauses, bodies) |cl, *l| {
            l.* = try f.newLabel();
            switch (cl.data) {
                .case_clause => |cc| {
                    try f.emit1(.get_loc, r);
                    try f.expr(cc.expr);
                    try f.emit0(.strict_eq);
                    try f.jump(.jmp_true, l.*);
                },
                else => default = l.*,
            }
        }
        const brk = try f.newLabel();
        try f.jump(.jmp, default orelse brk);
        try f.ctl.append(f.comp.a, .{ .kind = .breakable, .labels = labels, .unlabeled = true, .brk = brk });
        for (clauses, bodies) |cl, l| {
            f.bind(l);
            try f.stmts(clauseStmts(cl));
        }
        _ = f.ctl.pop();
        f.bind(brk);
        try f.leaveScope(sc, mark);
    }

    fn clauseStmts(cl: *const Node) []const *Node {
        return switch (cl.data) {
            .case_clause => |cc| cc.stmts,
            .default_clause => |dc| dc.stmts,
            else => &.{},
        };
    }

    /// The `break` or `continue` that `n` is: every scope, iterator and `finally` between it and
    /// its target is left on the way.
    fn jumpOut(f: *Fn, n: *const Node, label: ?[]const u8, is_continue: bool) !void {
        var i = f.ctl.items.len;
        const target = target: while (i > 0) {
            i -= 1;
            const e = f.ctl.items[i];
            const kind_ok = if (is_continue) e.kind == .loop else e.kind == .loop or e.kind == .breakable;
            if (!kind_ok) continue;
            if (label) |l| {
                for (e.labels) |x| {
                    if (std.mem.eql(u8, x, l)) break :target e;
                }
            } else if (e.unlabeled) break :target e;
        } else return f.comp.fail(n, "a jump with no target");
        try f.leave(i + 1);
        if (!is_continue) if (target.iter) |r| try f.emit1(.iter_close, r);
        try f.jump(.jmp, if (is_continue) target.cont else target.brk);
    }

    /// Leaves every control entry above `floor`, innermost first.
    fn leave(f: *Fn, floor: usize) !void {
        var i = f.ctl.items.len;
        while (i > floor) {
            i -= 1;
            const e = f.ctl.items[i];
            switch (e.kind) {
                .env => try f.emit0(.pop_scope),
                .loop => if (e.iter) |r| try f.emit1(.iter_close, r),
                .breakable => {},
                .finally => {
                    // The `finally` runs, then jumps back here to keep leaving.
                    const stub = try f.newLabel();
                    try f.byte(@backingInt(Op.set_jump));
                    try f.word(e.rtype);
                    try f.word(e.rval);
                    try f.ref(stub, f.depth);
                    try f.jump(.jmp, e.entry);
                    f.bind(stub);
                },
            }
        }
    }

    /// `return` with its value on the stack.
    fn returnTop(f: *Fn) !void {
        const through_finally = for (f.ctl.items) |e| {
            if (e.kind == .finally) break true;
        } else false;
        if (through_finally) {
            const r = f.ret_reg orelse blk: {
                // Allocated once, below every register a scope reuses.
                const r = f.max_reg;
                f.max_reg += 1;
                f.ret_reg = r;
                break :blk r;
            };
            try f.emit1(.set_loc, r);
            try f.leave(0);
            try f.emit1(.get_loc, r);
        } else {
            try f.leave(0);
        }
        try f.emit0(.@"return");
    }

    fn tryStmt(f: *Fn, body: *Node, catch_clause: ?*Node, finally: ?*Node) !void {
        const mark = f.next_reg;
        const env = f.allocReg();
        try f.emit1(.save_env, env);
        var fin: ?Ctl = null;
        if (finally != null) {
            fin = .{ .kind = .finally, .rtype = f.allocReg(), .rval = f.allocReg(), .entry = try f.newLabel() };
            try f.ctl.append(f.comp.a, fin.?);
        }
        const end = try f.newLabel();
        var to_finally: std.ArrayList(Region) = .empty;

        const start = f.pos();
        try f.stmt(body, &.{});
        const body_region: Region = .{ .start = start, .end = f.pos() };
        try f.normalExit(fin, end);

        if (catch_clause) |cc_node| {
            const cc = cc_node.data.catch_clause;
            const target = f.pos();
            try f.handlers.append(f.comp.a, .{ .start = body_region.start, .end = body_region.end, .target = target, .depth = 0 });
            f.depth = 1;
            try f.emit1(.restore_env, env);
            const sc = f.comp.res.scopes.get(cc_node) orelse unreachable;
            const scope_mark = f.next_reg;
            try f.enterScope(sc);
            if (cc.decl) |d| {
                const id = d.data.var_decl.name;
                if (id.data != .identifier) return f.comp.fail(id, "a destructuring catch parameter");
                try f.storeInit(f.comp.res.refs.get(id) orelse unreachable);
            } else try f.emit0(.pop);
            try f.stmt(cc.block, &.{});
            try f.leaveScope(sc, scope_mark);
            try to_finally.append(f.comp.a, .{ .start = target, .end = f.pos() });
            try f.normalExit(fin, end);
        } else {
            try to_finally.append(f.comp.a, body_region);
        }

        if (fin) |e| {
            _ = f.ctl.pop();
            const target = f.pos();
            for (to_finally.items) |r| try f.handlers.append(f.comp.a, .{ .start = r.start, .end = r.end, .target = target, .depth = 0 });
            f.depth = 1;
            try f.emit1(.restore_env, env);
            try f.emit1(.set_loc, e.rval);
            try f.pushNum(1);
            try f.emit1(.set_loc, e.rtype);
            f.bind(e.entry);
            try f.stmt(finally.?, &.{});
            try f.emit2(.end_finally, e.rtype, e.rval);
        }
        f.bind(end);
        f.next_reg = mark;
    }

    /// A `try` or `catch` block finishing normally: into the `finally` with completion type 0,
    /// or past the statement.
    fn normalExit(f: *Fn, fin: ?Ctl, end: u32) !void {
        if (fin) |e| {
            try f.pushNum(0);
            try f.emit1(.set_loc, e.rtype);
            try f.jump(.jmp, e.entry);
        } else try f.jump(.jmp, end);
    }

    // ---------------------------------------------------------------- expressions

    fn exprNamed(f: *Fn, n: *Node, hint: []const u8) Error!void {
        const u = unparen(n);
        if (u.data == .func and u.data.func.name == null) return f.closure(u, hint);
        try f.expr(n);
    }

    fn expr(f: *Fn, n: *Node) Error!void {
        switch (n.data) {
            .numeric_lit => |raw| try f.pushNum(jstext.numericLiteral(raw) orelse return f.comp.fail(n, "a numeric literal")),
            .string_lit, .no_subst_template => |s| try f.emit1(.push_const, try f.constStr(s)),
            .template_expr => |t| {
                try f.emit1(.push_const, try f.constStr(t.head));
                for (t.spans) |sp| {
                    const span = sp.data.template_span;
                    try f.expr(span.expr);
                    try f.emit0(.to_string);
                    try f.emit0(.add);
                    if (span.text.len > 0) {
                        try f.emit1(.push_const, try f.constStr(span.text));
                        try f.emit0(.add);
                    }
                }
            },
            .regex_lit => |raw| {
                const slash = std.mem.lastIndexOfScalar(u8, raw, '/') orelse return f.comp.fail(n, "a regular expression");
                try f.emit1(.push_const, try f.constStr(raw[1..slash]));
                try f.emit1(.push_const, try f.constStr(raw[slash + 1 ..]));
                try f.emit0(.regexp);
            },
            .true_lit => try f.emit0(.push_true),
            .false_lit => try f.emit0(.push_false),
            .null_lit => try f.emit0(.push_null),
            .this_expr => if (f.comp.res.refs.get(n)) |b| try f.load(b) else try f.emit0(.global_this),
            .identifier => try f.identLoad(n),
            .paren => |p| try f.expr(p.expr),
            .array_lit => |arr| {
                for (arr.elems) |e| switch (e.data) {
                    .omitted_expr => try f.emit0(.push_hole),
                    .spread_elem => return f.comp.fail(e, "a spread element"),
                    else => try f.expr(e),
                };
                if (arr.elems.len > std.math.maxInt(u16)) return f.comp.fail(n, "an array literal this long");
                try f.emit1(.new_array, @intCast(arr.elems.len));
            },
            .object_lit => |o| try f.objectLit(o.props),
            .func => try f.closure(n, null),
            .prop_access, .elem_access, .call => try f.chain(n),
            .new_expr => |ne| {
                try f.expr(ne.callee);
                try f.args(ne.args);
                try f.emitArgc(.new, n, ne.args.len);
            },
            .prefix => |p| switch (p.op) {
                .plus2, .minus2 => try f.update(p.expr, p.op == .plus2, true),
                .bang => try f.unary(p.expr, .not),
                .minus => try f.unary(p.expr, .neg),
                .plus => try f.unary(p.expr, .plus),
                .tilde => try f.unary(p.expr, .bitnot),
                else => return f.comp.fail(n, "a prefix operator"),
            },
            .postfix => |p| try f.update(p.expr, p.op == .plus2, false),
            .typeof_expr => |t| {
                const operand = unparen(t.expr);
                if (operand.data == .identifier and f.comp.res.refs.get(operand) == null and
                    !std.mem.eql(u8, operand.data.identifier, "undefined"))
                {
                    try f.emit1(.typeof_global, try f.name(operand.data.identifier));
                } else try f.unary(t.expr, .typeof);
            },
            .void_expr => |v| {
                try f.expr(v.expr);
                try f.emit0(.pop);
                try f.emit0(.push_undef);
            },
            .delete_expr => |d| try f.delete(d.expr),
            .binary => |b| try f.binary(n, b.left, b.op, b.right),
            .conditional => |cnd| {
                const els = try f.newLabel();
                const end = try f.newLabel();
                try f.expr(cnd.cond);
                try f.jump(.jmp_false, els);
                try f.expr(cnd.then);
                try f.jump(.jmp, end);
                f.bind(els);
                try f.expr(cnd.els);
                f.bind(end);
            },
            .class => return f.comp.fail(n, "a class"),
            .super_expr => return f.comp.fail(n, "super"),
            .await_expr => return f.comp.fail(n, "await"),
            .yield_expr => return f.comp.fail(n, "yield"),
            .meta_property => return f.comp.fail(n, "new.target or import.meta"),
            .tagged_template => return f.comp.fail(n, "a tagged template"),
            else => return f.comp.fail(n, @tagName(n.data)),
        }
    }

    fn unary(f: *Fn, operand: *Node, op: Op) !void {
        try f.expr(operand);
        try f.emit0(op);
    }

    fn args(f: *Fn, list: []const *Node) !void {
        for (list) |a| {
            if (a.data == .spread_elem) return f.comp.fail(a, "a spread argument");
            try f.expr(a);
        }
    }

    fn delete(f: *Fn, operand: *Node) !void {
        const t = unparen(operand);
        switch (t.data) {
            .prop_access, .elem_access => if (try f.member(t)) |key| try f.emit1(.delete_field, key) else try f.emit0(.delete_elem),
            .identifier => |id| if (f.comp.res.refs.get(t) != null) {
                // A declared binding is not deletable.
                try f.emit0(.push_false);
            } else {
                try f.emit0(.global_this);
                try f.emit1(.delete_field, try f.name(id));
            },
            else => {
                try f.expr(operand);
                try f.emit0(.pop);
                try f.emit0(.push_true);
            },
        }
    }

    /// A member chain, whose `?.` links all skip to one `undefined` (ECMA-262 §13.3.9).
    fn chain(f: *Fn, n: *Node) !void {
        var shorts: std.ArrayList(Short) = .empty;
        const base = f.depth;
        try f.chainExpr(n, &shorts);
        if (shorts.items.len == 0) return;
        const end = try f.newLabel();
        try f.jump(.jmp, end);
        for (shorts.items) |s| {
            f.bind(s.label);
            var k = s.depth - base;
            while (k > 0) : (k -= 1) try f.emit0(.pop);
            try f.emit0(.push_undef);
            try f.jump(.jmp, end);
        }
        f.bind(end);
    }

    fn optional(f: *Fn, shorts: *std.ArrayList(Short)) !void {
        const l = try f.newLabel();
        try f.emit0(.dup);
        try f.jump(.jmp_nullish, l);
        try shorts.append(f.comp.a, .{ .label = l, .depth = f.depth });
    }

    fn chainExpr(f: *Fn, n: *Node, shorts: *std.ArrayList(Short)) Error!void {
        switch (n.data) {
            .prop_access => |p| {
                try f.chainExpr(p.expr, shorts);
                if (p.optional) try f.optional(shorts);
                try f.field(p.name);
            },
            .elem_access => |e| {
                try f.chainExpr(e.expr, shorts);
                if (e.optional) try f.optional(shorts);
                try f.expr(e.index);
                try f.emit1(.get_elem, f.ic());
            },
            .call => |cl| {
                const callee = unparen(cl.callee);
                var method = true;
                switch (callee.data) {
                    .prop_access => |p| {
                        try f.chainExpr(p.expr, shorts);
                        if (p.optional) try f.optional(shorts);
                        try f.emit0(.dup);
                        try f.field(p.name);
                    },
                    .elem_access => |e| {
                        try f.chainExpr(e.expr, shorts);
                        if (e.optional) try f.optional(shorts);
                        try f.emit0(.dup);
                        try f.expr(e.index);
                        try f.emit1(.get_elem, f.ic());
                    },
                    .super_expr => return f.comp.fail(callee, "super"),
                    else => {
                        method = false;
                        try f.chainExpr(cl.callee, shorts);
                    },
                }
                if (cl.optional) try f.optional(shorts);
                try f.args(cl.args);
                try f.emitArgc(if (method) .call_method else .call, n, cl.args.len);
            },
            else => try f.expr(n),
        }
    }

    fn field(f: *Fn, name_node: *const Node) !void {
        try f.emit2(.get_field, try f.fieldName(name_node), f.ic());
    }

    fn fieldName(f: *Fn, name_node: *const Node) !u16 {
        if (name_node.data != .identifier) return f.comp.fail(name_node, "a private name");
        return f.name(name_node.data.identifier);
    }

    /// Pushes a member reference's object, and the key of an element access: [] → [o] / [o k].
    /// Answers the name of a property access, or null for an element access.
    fn member(f: *Fn, t: *const Node) !?u16 {
        switch (t.data) {
            .prop_access => |p| {
                try f.expr(p.expr);
                return try f.fieldName(p.name);
            },
            .elem_access => |e| {
                try f.expr(e.expr);
                try f.expr(e.index);
                return null;
            },
            else => unreachable,
        }
    }

    fn binaryOp(op: Tok) ?Op {
        return switch (op) {
            .plus, .plus_assign => .add,
            .minus, .minus_assign => .sub,
            .star, .star_assign => .mul,
            .slash, .slash_assign => .div,
            .percent, .percent_assign => .mod,
            .star2, .star2_assign => .pow,
            .amp, .amp_assign => .bitand,
            .pipe, .pipe_assign => .bitor,
            .caret, .caret_assign => .bitxor,
            .shl, .shl_assign => .shl,
            .shr, .shr_assign => .shr,
            .ushr, .ushr_assign => .ushr,
            else => for (comparisons) |pair| {
                if (pair[0] == op) break pair[1];
            } else null,
        };
    }

    /// The binary operators with no compound-assignment form.
    const comparisons = [_]struct { Tok, Op }{ .{ .lt, .lt }, .{ .gt, .gt }, .{ .lte, .le }, .{ .gte, .ge }, .{ .eq2, .eq }, .{ .neq, .ne }, .{ .eq3, .strict_eq }, .{ .neq3, .strict_ne }, .{ .kw_in, .in }, .{ .kw_instanceof, .instanceof } };

    const Logic = enum { @"and", @"or", nullish };

    fn logicOf(op: Tok) ?Logic {
        return switch (op) {
            .amp2, .amp2_assign => .@"and",
            .pipe2, .pipe2_assign => .@"or",
            .qq, .qq_assign => .nullish,
            else => null,
        };
    }

    /// With the operand on the stack: jumps to `l` keeping it when the operator short-circuits,
    /// and falls through keeping it otherwise.
    fn shortCircuit(f: *Fn, logic: Logic, l: u32) !void {
        try f.emit0(.dup);
        switch (logic) {
            .@"and" => try f.jump(.jmp_false, l),
            .@"or" => try f.jump(.jmp_true, l),
            .nullish => {
                const go_on = try f.newLabel();
                try f.jump(.jmp_nullish, go_on);
                try f.jump(.jmp, l);
                f.bind(go_on);
            },
        }
    }

    fn binary(f: *Fn, n: *Node, left: *Node, op: Tok, right: *Node) !void {
        switch (op) {
            .comma => {
                try f.expr(left);
                try f.emit0(.pop);
                return f.expr(right);
            },
            .assign => return f.assign(n, left, right),
            .amp2, .pipe2, .qq => {
                const end = try f.newLabel();
                try f.expr(left);
                try f.shortCircuit(logicOf(op).?, end);
                try f.emit0(.pop);
                try f.expr(right);
                f.bind(end);
                return;
            },
            .amp2_assign, .pipe2_assign, .qq_assign => return f.logicalAssign(left, logicOf(op).?, right),
            else => {},
        }
        const bop = binaryOp(op) orelse return f.comp.fail(n, "an operator");
        if (op != .kw_in and op != .kw_instanceof and @backingInt(op) >= @backingInt(Tok.assign)) {
            return f.compoundAssign(left, bop, right);
        }
        if (left.data == .private_name) return f.comp.fail(left, "a private name");
        try f.expr(left);
        try f.expr(right);
        try f.emit0(bop);
    }

    fn assign(f: *Fn, n: *Node, left: *Node, right: *Node) !void {
        const t = unparen(left);
        switch (t.data) {
            .identifier => |id| {
                try f.exprNamed(right, id);
                try f.identStore(t, true);
            },
            .prop_access => |p| {
                try f.expr(p.expr);
                try f.expr(right);
                if (p.name.data != .identifier) return f.comp.fail(p.name, "a private name");
                try f.emit2(.put_field, try f.name(p.name.data.identifier), f.ic());
            },
            .elem_access => |e| {
                try f.expr(e.expr);
                try f.expr(e.index);
                try f.expr(right);
                try f.emit1(.put_elem, f.ic());
            },
            else => return f.comp.fail(n, "a destructuring assignment"),
        }
    }

    /// Pushes a reference's object (and key) and its current value: [o v] or [o k v]. Answers
    /// whether it is a member reference at all.
    fn loadRef(f: *Fn, t: *Node) !void {
        switch (t.data) {
            .identifier => try f.identLoad(t),
            .prop_access, .elem_access => if (try f.member(t)) |key| {
                try f.emit0(.dup);
                try f.emit2(.get_field, key, f.ic());
            } else {
                try f.emit0(.dup2);
                try f.emit1(.get_elem, f.ic());
            },
            else => return f.comp.fail(t, "an assignment target"),
        }
    }

    /// Stores into the reference `loadRef` opened: [o v] / [o k v] / [v] → [v].
    fn storeRef(f: *Fn, t: *Node) !void {
        switch (t.data) {
            .identifier => try f.identStore(t, true),
            .prop_access => |p| try f.emit2(.put_field, try f.name(p.name.data.identifier), f.ic()),
            .elem_access => try f.emit1(.put_elem, f.ic()),
            else => unreachable,
        }
    }

    fn compoundAssign(f: *Fn, left: *Node, op: Op, right: *Node) !void {
        const t = unparen(left);
        try f.loadRef(t);
        try f.expr(right);
        try f.emit0(op);
        try f.storeRef(t);
    }

    fn logicalAssign(f: *Fn, left: *Node, logic: Logic, right: *Node) !void {
        const t = unparen(left);
        const skip = try f.newLabel();
        const end = try f.newLabel();
        try f.loadRef(t);
        try f.shortCircuit(logic, skip);
        try f.emit0(.pop);
        if (t.data == .identifier) try f.exprNamed(right, t.data.identifier) else try f.expr(right);
        try f.storeRef(t);
        try f.jump(.jmp, end);
        f.bind(skip);
        // Only the value survives a short circuit.
        const extra: u32 = switch (t.data) {
            .identifier => 0,
            .prop_access => 1,
            else => 2,
        };
        for (0..extra) |_| {
            try f.emit0(.swap);
            try f.emit0(.pop);
        }
        f.bind(end);
    }

    /// `++x`, `x--` and the member forms; a postfix form answers the old value, as a number.
    fn update(f: *Fn, operand: *Node, inc: bool, prefix: bool) !void {
        const t = unparen(operand);
        const op: Op = if (inc) .inc else .dec;
        try f.loadRef(t);
        if (prefix) {
            try f.emit0(op);
            return f.storeRef(t);
        }
        try f.emit0(.to_numeric);
        const old = f.allocReg();
        try f.emit1(.put_loc, old);
        try f.emit0(op);
        try f.storeRef(t);
        try f.emit0(.pop);
        try f.emit1(.get_loc, old);
        f.next_reg = old;
    }

    /// A property name as the static key it spells, or null for a computed one.
    fn staticKey(f: *Fn, n: *const Node) !?[]const u8 {
        return switch (n.data) {
            .identifier, .string_lit => |s| s,
            .numeric_lit => |raw| try jstext.numberToString(f.comp.a, jstext.numericLiteral(raw) orelse return f.comp.fail(n, "a numeric key")),
            .computed_name => null,
            else => return f.comp.fail(n, "a property name"),
        };
    }

    fn objectLit(f: *Fn, props: []const *Node) !void {
        try f.emit0(.new_object);
        for (props, 0..) |p, i| switch (p.data) {
            .property_assign => |pa| {
                if (try f.staticKey(pa.name)) |key| {
                    if (std.mem.eql(u8, key, "__proto__") and pa.name.data != .computed_name) return f.comp.fail(p, "a __proto__ property");
                    try f.exprNamed(pa.value, key);
                    try f.emit1(.def_field, try f.name(key));
                } else {
                    try f.expr(pa.name.data.computed_name.expr);
                    try f.expr(pa.value);
                    try f.emit0(.def_elem);
                }
            },
            .shorthand_assign => |sa| {
                if (sa.init != null) return f.comp.fail(p, "a destructuring default");
                try f.identLoad(sa.name);
                try f.emit1(.def_field, try f.name(sa.name.data.identifier));
            },
            .spread_assign => |sp| {
                try f.expr(sp.expr);
                try f.emit0(.copy_data);
            },
            .func => |fd| {
                if (fd.asterisk or p.mods.async) return f.comp.fail(p, "a generator or async method");
                const name_node = fd.name orelse unreachable;
                const key = try f.staticKey(name_node);
                switch (fd.kind) {
                    .getter, .setter => {
                        const k = key orelse return f.comp.fail(p, "a computed accessor name");
                        // One accessor property per name: its other half, when the literal has one,
                        // comes along, and a half already emitted is skipped.
                        if (accessorPartner(props[0..i], k) != null) continue;
                        const partner = accessorPartner(props[i + 1 ..], k);
                        const getter = if (fd.kind == .getter) p else partner;
                        const setter = if (fd.kind == .setter) p else partner;
                        if (getter) |g| try f.closure(g, k) else try f.emit0(.push_undef);
                        if (setter) |s| try f.closure(s, k) else try f.emit0(.push_undef);
                        try f.emit1(.def_accessor, try f.name(k));
                    },
                    else => if (key) |k| {
                        try f.closure(p, k);
                        try f.emit1(.def_field, try f.name(k));
                    } else {
                        try f.expr(name_node.data.computed_name.expr);
                        try f.closure(p, null);
                        try f.emit0(.def_elem);
                    },
                }
            },
            else => return f.comp.fail(p, "an object literal member"),
        };
    }

    /// The other accessor half named `key` among `props`.
    fn accessorPartner(props: []const *Node, key: []const u8) ?*Node {
        for (props) |p| {
            if (p.data != .func) continue;
            const fd = p.data.func;
            if (fd.kind != .getter and fd.kind != .setter) continue;
            const n = fd.name orelse continue;
            const k = switch (n.data) {
                .identifier, .string_lit => |s| s,
                else => continue,
            };
            if (std.mem.eql(u8, k, key)) return p;
        }
        return null;
    }
};

fn unparen(n: *Node) *Node {
    var cur = n;
    while (cur.data == .paren) cur = cur.data.paren.expr;
    return cur;
}

/// An interned property key: immortal, and equal by pointer to every other spelling of it.
fn intern(bytes: []const u8) [*:0]const u8 {
    return @ptrCast(c.jsrt_shape_key(c.jsrt_string_from_utf8(bytes.ptr, bytes.len)));
}

fn compileFunction(comp: *Compiler, parent: *Fn, n: *Node, fn_name: []const u8) Error!*bc.Proto {
    const fd = n.data.func;
    if (fd.asterisk or n.mods.async) return comp.fail(n, "a generator or async function");
    const info = comp.res.functions.get(n) orelse unreachable;
    var f: Fn = .{ .comp = comp, .parent = parent, .info = info, .strict = info.strict };
    var name_bytes = fn_name;
    if (fd.name) |id| {
        if (id.data == .identifier and (fd.kind == .decl or fd.kind == .expr)) name_bytes = id.data.identifier;
    }
    if (info.name_scope) |ns| {
        try f.enterScope(ns);
        try f.emit0(.get_callee);
        try f.storeInit(ns.bindings.values()[0]);
    }
    try f.enterScope(info.scope);
    const this_binding = info.scope.bindings.get("this");
    if (this_binding) |b| if (b.kind == .this) {
        try f.emit0(.get_this);
        try f.storeInit(b);
    };
    if (info.scope.bindings.get("arguments")) |b| if (b.kind == .arguments) {
        try f.emit0(.get_arguments);
        try f.storeInit(b);
    };
    var arity: u32 = 0;
    var counting = true;
    for (fd.params, 0..) |p, i| {
        const param = p.data.param;
        if (param.name.data != .identifier) return comp.fail(param.name, "a destructuring parameter");
        if (param.dotdotdot or param.init != null) counting = false;
        if (counting) arity += 1;
        try f.emit1(if (param.dotdotdot) .get_rest else .get_arg, @intCast(i));
        if (param.init) |init| {
            const given = try f.newLabel();
            try f.emit0(.dup);
            try f.emit0(.push_undef);
            try f.emit0(.strict_eq);
            try f.jump(.jmp_false, given);
            try f.emit0(.pop);
            try f.exprNamed(init, param.name.data.identifier);
            f.bind(given);
        }
        try f.storeInit(comp.res.refs.get(param.name) orelse unreachable);
    }
    const body = fd.body orelse return comp.fail(n, "a function without a body");
    switch (body.data) {
        .block => |b| {
            try f.hoistFunctions(info.scope, b.stmts);
            try f.stmts(b.stmts);
            try f.emit0(.return_undef);
        },
        else => {
            try f.expr(body);
            try f.emit0(.@"return");
        },
    }
    return f.finish(name_bytes, arity, .{
        .strict = info.strict,
        .constructible = fd.kind == .decl or fd.kind == .expr,
        .has_receiver = if (this_binding) |b| b.kind == .this else false,
    });
}
