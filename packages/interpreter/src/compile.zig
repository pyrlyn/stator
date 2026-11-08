//! stator-ts's tree to bytecode (docs/INTERPRETER.md §2). Scope analysis is decided per function:
//! a function that contains another function keeps every binding it declares in environments,
//! one per scope, because something nested may capture any of them; a function that contains
//! none keeps them in frame locals. Names resolve at compile time to a local, an environment slot
//! `hops` levels out, or the global object.

const std = @import("std");
const Allocator = std.mem.Allocator;
const parse = @import("parse.zig");
const bc = @import("bytecode.zig");
const rt = @import("rt.zig");
const c = rt.c;
const Op = bc.Op;
const Kind = bc.Kind;
const Template = bc.Template;

const Node = parse.Node;
const Data = @FieldType(Node, "data");
const Tok = @FieldType(@FieldType(Data, "binary"), "op");
const Func = std.meta.Child(@FieldType(Data, "func"));
const Class = std.meta.Child(@FieldType(Data, "class"));
const VarKind = @FieldType(@FieldType(Data, "var_list"), "kind");

/// The slots of the environment a closure carries (docs/INTERPRETER.md §4): its template, its
/// home object, the class it extends, its instance-field initializer, and the closure itself.
/// The scope the function closes over is the environment's parent.
pub const fnenv_template = 0;
pub const fnenv_home = 1;
pub const fnenv_parent = 2;
pub const fnenv_fields = 3;
pub const fnenv_self = 4;
pub const fnenv_size = 5;

/// The names a function binds for its own `this`, `new.target`, home object and closure, so an
/// arrow inside reads them lexically. None is an identifier a program can write.
const this_name = "%this";
const nt_name = "%nt";
const home_name = "%home";
const fn_name = "%fn";
const specials = [_][]const u8{ this_name, nt_name, home_name, fn_name };

pub const Error = error{ Unsupported, OutOfMemory };

pub const Compiled = union(enum) {
    template: *Template,
    /// A construct the interpreter does not run yet: the source position and what it is.
    unsupported: struct { offset: u32, what: []const u8 },
    /// An early error (§16.1.1) the parser does not report: the script must not run at all.
    syntax_error: struct { offset: u32, message: [:0]const u8 },
};

/// A binding of the compiled code around a direct `eval` (docs/INTERPRETER.md §3). The eval
/// code reaches it through a pointer held in slot `i` of the outermost environment, for the
/// binding at index `i` of the list.
pub const Outer = struct { name: []const u8, constant: bool };

/// Compiles a parsed script. `perm` owns the templates, which outlive the compile.
pub fn compileScript(a: Allocator, perm: Allocator, file: *parse.File, strict: bool) Error!Compiled {
    return compileCode(a, perm, file, strict, null);
}

/// Compiles direct-eval code: strict (every caller is a module), its `var`s and functions its
/// own, and its free names resolved first against `outer`.
pub fn compileEval(a: Allocator, perm: Allocator, file: *parse.File, outer: []const Outer) Error!Compiled {
    return compileCode(a, perm, file, true, outer);
}

/// Compiles the one function `parse.parseFunction` made, in the global scope (`new Function`).
pub fn compileDynamicFunction(a: Allocator, perm: Allocator, file: *parse.File, n: *Node) Error!Compiled {
    var comp: Compiler = .{ .a = a, .perm = perm, .src = file.src };
    const t = compileFunction(&comp, null, n, n.data.func, .function, "anonymous", false, null) catch |e| return comp.failed(e);
    return .{ .template = t };
}

fn compileCode(a: Allocator, perm: Allocator, file: *parse.File, strict: bool, outer: ?[]const Outer) Error!Compiled {
    var comp: Compiler = .{ .a = a, .perm = perm, .src = file.src };
    const t = comp.script(file.root.data.source_file.stmts, strict, outer) catch |e| return comp.failed(e);
    return .{ .template = t };
}

const BKind = enum { var_, let_, const_, class_, func, param, callee, special };

/// `ref` is a slot holding a pointer to a compiled caller's binding (`Outer`).
const Loc = union(enum) { local: u16, env: u16, global: []const u8, ref: u16 };

const Binding = struct {
    loc: Loc,
    kind: BKind,

    fn tdz(b: Binding) bool {
        return b.kind == .let_ or b.kind == .const_ or b.kind == .class_;
    }
};

const Scope = struct {
    parent: ?*Scope,
    names: std.StringHashMapUnmanaged(Binding) = .empty,
    /// The bindings live in an environment this scope pushes on entry.
    env: bool,
    count: u16 = 0,
    /// Top-level `var`s and functions of a script are the global object's.
    script: bool = false,
};

const CtxKind = enum { loop, switch_, block, finally_, forof };

const JumpReq = struct { target: usize, is_continue: bool };

const Ctx = struct {
    kind: CtxKind,
    labels: []const []const u8,
    breaks: std.ArrayList(u32) = .empty,
    continues: std.ArrayList(u32) = .empty,
    env_level: u32,
    // finally
    kind_local: u16 = 0,
    val_local: u16 = 0,
    fin_patches: std.ArrayList(u32) = .empty,
    jumps: std.ArrayList(JumpReq) = .empty,
    // forof
    iter_local: u16 = 0,
};

/// Where an optional chain jumps when a link is nullish, with the stack depth at that point.
const Chain = struct {
    exits: std.ArrayList(struct { patch: u32, depth: u32 }) = .empty,
};

const Compiler = struct {
    a: Allocator,
    perm: Allocator,
    src: []const u8,
    bad_offset: u32 = 0,
    bad_what: []const u8 = "",
    early: ?[:0]const u8 = null,

    fn failed(comp: *Compiler, e: Error) Error!Compiled {
        return switch (e) {
            error.Unsupported => if (comp.early) |msg|
                .{ .syntax_error = .{ .offset = comp.bad_offset, .message = msg } }
            else
                .{ .unsupported = .{ .offset = comp.bad_offset, .what = comp.bad_what } },
            error.OutOfMemory => error.OutOfMemory,
        };
    }

    fn syntaxError(comp: *Compiler, n: *const Node, message: [:0]const u8) Error {
        comp.early = message;
        return comp.stopAt(n);
    }

    fn unsupported(comp: *Compiler, n: *const Node, what: []const u8) Error {
        comp.bad_what = what;
        return comp.stopAt(n);
    }

    fn stopAt(comp: *Compiler, n: *const Node) Error {
        comp.bad_offset = n.start;
        return error.Unsupported;
    }

    fn script(comp: *Compiler, stmts: []*Node, strict_in: bool, outer: ?[]const Outer) Error!*Template {
        const strict = strict_in or hasUseStrict(stmts);
        var fs: Fn = .{ .comp = comp, .kind = .script, .strict = strict, .env_mode = containsFunctionList(stmts) };
        const refs = if (outer) |o| try fs.refScope(o) else null;
        const scope = try fs.newScope(refs, true);
        // Strict eval code keeps its `var`s and functions to itself (§19.2.1.3 step 16).
        scope.script = outer == null;
        try fs.declareSpecials(scope);
        try fs.hoistVars(scope, stmts);
        try fs.hoistLexical(scope, stmts);
        try fs.enterScope(scope);
        try fs.initSpecials(scope);
        try fs.declareGlobals(scope);
        try fs.instantiateFunctions(stmts);
        fs.completion = fs.newLocal();
        for (stmts) |s| try fs.stmt(s);
        try fs.op16(.load, fs.completion.?);
        try fs.op(.ret);
        return fs.finish("", 0, 0);
    }
};

/// The per-function state of the compiler.
const Fn = struct {
    comp: *Compiler,
    kind: Kind,
    strict: bool,
    env_mode: bool,
    code: std.ArrayList(u8) = .empty,
    strings: std.ArrayList([]const u8) = .empty,
    numbers: std.ArrayList(f64) = .empty,
    keys: std.ArrayList([*:0]const u8) = .empty,
    key_index: std.StringHashMapUnmanaged(u16) = .empty,
    funcs: std.ArrayList(*Template) = .empty,
    handlers: std.ArrayList(bc.Handler) = .empty,
    nlocals: u16 = 0,
    nics: u16 = 0,
    depth: i32 = 0,
    max_depth: i32 = 0,
    scope: ?*Scope = null,
    env_level: u32 = 0,
    ctx: std.ArrayList(Ctx) = .empty,
    /// Labels written just before the statement being compiled.
    pending_labels: std.ArrayList([]const u8) = .empty,
    /// A script's completion value: the value of the last expression statement it ran, which
    /// is close to §8.2 UpdateEmpty without tracking what each loop and `if` leaves empty.
    completion: ?u16 = null,

    fn alloc(fs: *Fn) Allocator {
        return fs.comp.a;
    }

    fn finish(fs: *Fn, name: []const u8, arity: u32, start: u32) Error!*Template {
        const p = fs.comp.perm;
        const t = try p.create(Template);
        const ics = try p.alloc(c.JSRTIC, fs.nics);
        @memset(ics, .{ .shape = null, .offset = 0 });
        const strings = try p.alloc([]const u8, fs.strings.items.len);
        for (strings, fs.strings.items) |*d, s| d.* = try p.dupe(u8, s);
        t.* = .{
            .code = try p.dupe(u8, fs.code.items),
            .strings = strings,
            .numbers = try p.dupe(f64, fs.numbers.items),
            .keys = try p.dupe([*:0]const u8, fs.keys.items),
            .funcs = try p.dupe(*Template, fs.funcs.items),
            .ics = ics,
            .handlers = try p.dupe(bc.Handler, fs.handlers.items),
            .nlocals = fs.nlocals,
            .max_stack = @intCast(fs.max_depth + 2),
            .arity = arity,
            .name = intern(name),
            .kind = fs.kind,
            .strict = fs.strict,
            .start = start,
        };
        return t;
    }

    // ------------------------------------------------------------------ emitting

    fn byte(fs: *Fn, b: u8) Error!void {
        try fs.code.append(fs.alloc(), b);
    }

    /// A little-endian operand.
    fn operand(fs: *Fn, comptime T: type, v: T) Error!void {
        try fs.code.appendSlice(fs.alloc(), std.mem.asBytes(&std.mem.nativeToLittle(T, v)));
    }

    fn adjust(fs: *Fn, delta: i32) void {
        fs.depth += delta;
        if (fs.depth > fs.max_depth) fs.max_depth = fs.depth;
    }

    fn pc(fs: *Fn) u32 {
        return @intCast(fs.code.items.len);
    }

    /// An operand-free op, with its stack effect.
    fn op(fs: *Fn, o: Op) Error!void {
        try fs.byte(@backingInt(o));
        fs.adjust(switch (o) {
            .undef, .null, .true, .false, .uninit, .dup, .arguments, .this_raw, .this_sloppy, .new_target, .callee, .home, .new_object => 1,
            .dup2 => 2,
            .pop, .get_elem, .in, .instanceof, .add, .sub, .mul, .div, .mod, .exp, .bitand, .bitor, .bitxor, .shl, .shr, .ushr, .eq, .ne, .seq, .sne, .lt, .gt, .le, .ge, .delete_elem, .new_spread, .ret, .throw, .array_push, .array_spread, .object_spread, .set_proto, .set_field_init, .iter_close, .assert_uninit => -1,
            .set_elem, .ret_ctor, .define_elem, .run_field_init, .super_call_spread, .call_spread, .super_get_elem, .iter_close_quiet => -2,
            .swap, .insert3, .insert4, .pop_env, .clone_env, .neg, .plus, .bitnot, .not, .typeof, .inc, .dec, .to_string, .to_key, .array_hole, .get_iterator, .iter_rest, .for_in_keys, .debugger => 0,
            .iter_value => 1,
            else => unreachable,
        });
    }

    fn op16(fs: *Fn, o: Op, v: u16) Error!void {
        try fs.byte(@backingInt(o));
        try fs.operand(u16, v);
        fs.adjust(switch (o) {
            .num, .str, .load, .load_global, .typeof_global, .delete_global, .arg, .rest => 1,
            .store, .store_global => -1,
            .push_env, .save_env, .const_assign, .delete_prop, .throw_error, .declare_global => 0,
            .call => -@as(i32, v) - 1,
            .new => -@as(i32, v),
            .super_call => -@as(i32, v) - 1,
            .new_array => 1 - @as(i32, v),
            .define => -1,
            .closure => 1,
            .tagged_template => -@as(i32, v) - 1,
            .super_get => -1,
            else => unreachable,
        });
    }

    fn int(fs: *Fn, v: i32) Error!void {
        try fs.byte(@backingInt(Op.int));
        try fs.operand(u32, @bitCast(v));
        fs.adjust(1);
    }

    fn jump(fs: *Fn, o: Op) Error!u32 {
        try fs.byte(@backingInt(o));
        const at = fs.pc();
        try fs.operand(u32, 0);
        fs.adjust(switch (o) {
            .jump, .iter_next => 0,
            .jump_if_false, .jump_if_true, .jump_if_nullish, .jump_if_not_undef => -1,
            else => unreachable,
        });
        return at;
    }

    fn jumpTo(fs: *Fn, o: Op, target: u32) Error!void {
        const at = try fs.jump(o);
        fs.patchTo(at, target);
    }

    fn patch(fs: *Fn, at: u32) void {
        fs.patchTo(at, fs.pc());
    }

    fn patchTo(fs: *Fn, at: u32, target: u32) void {
        std.mem.writeInt(u32, fs.code.items[at..][0..4], target, .little);
    }

    fn jumpIfInt(fs: *Fn, v: i32) Error!u32 {
        try fs.byte(@backingInt(Op.jump_if_int));
        try fs.operand(u32, @bitCast(v));
        const at = fs.pc();
        try fs.operand(u32, 0);
        fs.adjust(-1);
        return at;
    }

    fn propOp(fs: *Fn, o: Op, key: []const u8) Error!void {
        try fs.byte(@backingInt(o));
        try fs.operand(u16, try fs.keyIndex(key));
        try fs.operand(u16, fs.nics);
        fs.nics += 1;
        fs.adjust(if (o == .set_prop) -1 else 0);
    }

    fn envOp(fs: *Fn, o: Op, hops: u8, slot: u16, name: ?[]const u8) Error!void {
        try fs.byte(@backingInt(o));
        try fs.byte(hops);
        try fs.operand(u16, slot);
        if (name) |n| try fs.operand(u16, try fs.keyIndex(n));
        fs.adjust(switch (o) {
            .load_env, .load_env_checked, .load_ref => 1,
            .store_env, .store_env_checked, .store_ref => -1,
            else => unreachable,
        });
    }

    fn localOp(fs: *Fn, o: Op, slot: u16, name: []const u8) Error!void {
        try fs.byte(@backingInt(o));
        try fs.operand(u16, slot);
        try fs.operand(u16, try fs.keyIndex(name));
        fs.adjust(if (o == .load_checked) 1 else -1);
    }

    fn keyIndex(fs: *Fn, name: []const u8) Error!u16 {
        if (fs.key_index.get(name)) |i| return i;
        const i: u16 = @intCast(fs.keys.items.len);
        try fs.keys.append(fs.alloc(), intern(name));
        try fs.key_index.put(fs.alloc(), name, i);
        return i;
    }

    fn strIndex(fs: *Fn, s: []const u8) Error!u16 {
        for (fs.strings.items, 0..) |e, i| if (std.mem.eql(u8, e, s)) return @intCast(i);
        try fs.strings.append(fs.alloc(), s);
        return @intCast(fs.strings.items.len - 1);
    }

    fn string(fs: *Fn, s: []const u8) Error!void {
        try fs.op16(.str, try fs.strIndex(s));
    }

    fn setHome(fs: *Fn, depth: u8) Error!void {
        try fs.byte(@backingInt(Op.set_home));
        try fs.byte(depth);
    }

    fn number(fs: *Fn, d: f64) Error!void {
        if (d == @trunc(d) and @abs(d) < 2147483648 and !(d == 0 and std.math.signbit(d))) return fs.int(@intFromFloat(d));
        try fs.op16(.num, try fs.add(&fs.numbers, d));
    }

    /// `v` appended to one of the template's tables, as its index there.
    fn add(fs: *Fn, list: anytype, v: @TypeOf(list.items[0])) Error!u16 {
        try list.append(fs.alloc(), v);
        return @intCast(list.items.len - 1);
    }

    /// A closure over the nested template `t`.
    fn pushFunc(fs: *Fn, t: *Template) Error!void {
        try fs.op16(.closure, try fs.add(&fs.funcs, t));
    }

    fn newLocal(fs: *Fn) u16 {
        const l = fs.nlocals;
        fs.nlocals += 1;
        return l;
    }

    // ------------------------------------------------------------------ scopes

    fn newScope(fs: *Fn, parent: ?*Scope, function_scope: bool) Error!*Scope {
        _ = function_scope;
        const s = try fs.alloc().create(Scope);
        s.* = .{ .parent = parent, .env = fs.env_mode };
        return s;
    }

    /// The scope of a direct eval's caller: one environment of pointers, already made by the
    /// caller of the code, so nothing pushes it.
    fn refScope(fs: *Fn, outer: []const Outer) Error!*Scope {
        const s = try fs.alloc().create(Scope);
        s.* = .{ .parent = null, .env = true, .count = @intCast(outer.len) };
        for (outer, 0..) |o, i| try s.names.put(fs.alloc(), o.name, .{ .loc = .{ .ref = @intCast(i) }, .kind = if (o.constant) .const_ else .var_ });
        return s;
    }

    fn declare(fs: *Fn, scope: *Scope, name: []const u8, kind: BKind) Error!void {
        if (scope.names.getPtr(name)) |existing| {
            // A function declaration replaces a `var` of the same name; a later `var` keeps it.
            if (kind == .func and (existing.kind == .var_ or existing.kind == .callee)) existing.kind = .func;
            if (existing.kind == .callee and kind != .callee) existing.kind = kind;
            return;
        }
        const loc: Loc = if (scope.script and (kind == .var_ or kind == .func))
            .{ .global = name }
        else if (scope.env) blk: {
            scope.count += 1;
            break :blk .{ .env = scope.count - 1 };
        } else .{ .local = fs.newLocal() };
        try scope.names.put(fs.alloc(), name, .{ .loc = loc, .kind = kind });
    }

    fn enterScope(fs: *Fn, scope: *Scope) Error!void {
        fs.scope = scope;
        if (scope.env and scope.count > 0) {
            try fs.op16(.push_env, scope.count);
            fs.env_level += 1;
        }
        // Lexical bindings start uninitialized (the TDZ).
        var it = scope.names.iterator();
        while (it.next()) |e| if (e.value_ptr.tdz()) {
            try fs.op(.uninit);
            try fs.storeLoc(e.value_ptr.loc, 0, e.key_ptr.*);
        };
    }

    fn leaveScope(fs: *Fn, scope: *Scope) Error!void {
        if (scope.env and scope.count > 0) {
            try fs.op(.pop_env);
            fs.env_level -= 1;
        }
        fs.scope = scope.parent;
    }

    const Resolved = struct { b: Binding, hops: u8 };

    fn resolve(fs: *Fn, name: []const u8) ?Resolved {
        var hops: u8 = 0;
        var s = fs.scope;
        while (s) |sc| : (s = sc.parent) {
            if (sc.names.get(name)) |b| return .{ .b = b, .hops = hops };
            if (sc.env and sc.count > 0) hops += 1;
        }
        return null;
    }

    fn loadName(fs: *Fn, name: []const u8) Error!void {
        const r = fs.resolve(name) orelse return fs.op16(.load_global, try fs.keyIndex(name));
        const checked = r.b.tdz() or std.mem.eql(u8, name, this_name);
        switch (r.b.loc) {
            .local => |l| if (checked) try fs.localOp(.load_checked, l, name) else try fs.op16(.load, l),
            .env => |slot| try fs.envOp(if (checked) .load_env_checked else .load_env, r.hops, slot, if (checked) name else null),
            .global => |g| try fs.op16(.load_global, try fs.keyIndex(g)),
            .ref => |slot| try fs.envOp(.load_ref, r.hops, slot, null),
        }
    }

    /// `this` without the TDZ check: what a constructor's return decides on.
    fn loadRaw(fs: *Fn, name: []const u8) Error!void {
        const r = fs.resolve(name) orelse unreachable;
        switch (r.b.loc) {
            .local => |l| try fs.op16(.load, l),
            .env => |slot| try fs.envOp(.load_env, r.hops, slot, null),
            .global, .ref => unreachable,
        }
    }

    fn storeLoc(fs: *Fn, loc: Loc, hops: u8, name: []const u8) Error!void {
        switch (loc) {
            .local => |l| try fs.op16(.store, l),
            .env => |slot| try fs.envOp(.store_env, hops, slot, null),
            .global => |g| {
                try fs.byte(@backingInt(Op.store_global));
                try fs.operand(u16, try fs.keyIndex(g));
                try fs.byte(0);
                fs.adjust(-1);
            },
            .ref => |slot| try fs.envOp(.store_ref, hops, slot, null),
        }
        _ = name;
    }

    /// Initializes a binding the declaration owns: no TDZ check, no constant check.
    fn initName(fs: *Fn, name: []const u8) Error!void {
        const r = fs.resolve(name) orelse return fs.storeGlobal(name);
        try fs.storeLoc(r.b.loc, r.hops, name);
    }

    fn storeGlobal(fs: *Fn, name: []const u8) Error!void {
        try fs.byte(@backingInt(Op.store_global));
        try fs.operand(u16, try fs.keyIndex(name));
        try fs.byte(@intFromBool(fs.strict));
        fs.adjust(-1);
    }

    /// An assignment `name = <top of stack>`, which pops it.
    fn assignName(fs: *Fn, name: []const u8) Error!void {
        const r = fs.resolve(name) orelse return fs.storeGlobal(name);
        switch (r.b.kind) {
            .const_ => {
                if (r.b.loc == .local) {
                    // The TDZ outranks the constant: reading it first raises the right error.
                    try fs.localOp(.load_checked, r.b.loc.local, name);
                    try fs.op(.pop);
                } else if (r.b.loc == .env) {
                    try fs.envOp(.load_env_checked, r.hops, r.b.loc.env, name);
                    try fs.op(.pop);
                }
                try fs.op16(.const_assign, try fs.keyIndex(name));
                try fs.op(.pop);
                return;
            },
            .callee => {
                if (fs.strict) try fs.op16(.const_assign, try fs.keyIndex(name));
                try fs.op(.pop);
                return;
            },
            .let_, .class_ => switch (r.b.loc) {
                .local => |l| return fs.localOp(.store_checked, l, name),
                .env => |slot| return fs.envOp(.store_env_checked, r.hops, slot, name),
                .global, .ref => unreachable,
            },
            else => try fs.storeLoc(r.b.loc, r.hops, name),
        }
    }

    // ------------------------------------------------------------------ declarations

    fn declareSpecials(fs: *Fn, scope: *Scope) Error!void {
        for (specials) |name| try fs.declare(scope, name, .special);
    }

    fn initSpecials(fs: *Fn, scope: *Scope) Error!void {
        _ = scope;
        const this: Op = if (fs.kind == .derived_ctor) .uninit else if (fs.strict or fs.kind == .script) .this_raw else .this_sloppy;
        for ([_]Op{ this, .new_target, .home, .callee }, specials) |o, name| {
            try fs.op(o);
            try fs.initName(name);
        }
    }

    /// The global object's properties for a script's `var`s and functions (§16.1.7
    /// GlobalDeclarationInstantiation), before any statement runs.
    fn declareGlobals(fs: *Fn, scope: *Scope) Error!void {
        var it = scope.names.iterator();
        while (it.next()) |e| if (e.value_ptr.loc == .global) try fs.op16(.declare_global, try fs.keyIndex(e.key_ptr.*));
    }

    /// `var` declarations anywhere in the function body (not in nested functions), and the
    /// function declarations at its top level.
    fn hoistVars(fs: *Fn, scope: *Scope, stmts: []*Node) Error!void {
        for (stmts) |s| try fs.hoistVarsIn(scope, s, true);
    }

    fn hoistVarsIn(fs: *Fn, scope: *Scope, n: *Node, top: bool) Error!void {
        switch (n.data) {
            .var_stmt => |v| try fs.hoistVarList(scope, v.list),
            .func => |f| if (top and f.kind == .decl) {
                if (f.name) |name| try fs.declare(scope, name.data.identifier, .func);
            },
            .block => |b| for (b.stmts) |s| try fs.hoistVarsIn(scope, s, false),
            .if_stmt => |i| {
                try fs.hoistVarsIn(scope, i.then, false);
                if (i.els) |e| try fs.hoistVarsIn(scope, e, false);
            },
            .do_stmt => |d| try fs.hoistVarsIn(scope, d.body, false),
            .while_stmt => |w| try fs.hoistVarsIn(scope, w.body, false),
            .for_stmt => |f| {
                if (f.init) |i| if (i.data == .var_list) try fs.hoistVarList(scope, i);
                try fs.hoistVarsIn(scope, f.body, false);
            },
            inline .for_in, .for_of => |f| {
                if (f.init.data == .var_list) try fs.hoistVarList(scope, f.init);
                try fs.hoistVarsIn(scope, f.body, false);
            },
            .labeled => |l| try fs.hoistVarsIn(scope, l.stmt, top),
            .try_stmt => |t| {
                try fs.hoistVarsIn(scope, t.block, false);
                if (t.catch_clause) |cc| try fs.hoistVarsIn(scope, cc.data.catch_clause.block, false);
                if (t.finally) |f| try fs.hoistVarsIn(scope, f, false);
            },
            .switch_stmt => |sw| for (sw.clauses) |cl| switch (cl.data) {
                .case_clause => |cc| for (cc.stmts) |s| try fs.hoistVarsIn(scope, s, false),
                .default_clause => |d| for (d.stmts) |s| try fs.hoistVarsIn(scope, s, false),
                else => {},
            },
            .with_stmt => |w| try fs.hoistVarsIn(scope, w.body, false),
            else => {},
        }
    }

    fn hoistVarList(fs: *Fn, scope: *Scope, list: *Node) Error!void {
        const l = list.data.var_list;
        if (l.kind != .@"var") return;
        for (l.decls) |d| try fs.declarePattern(scope, d.data.var_decl.name, .var_);
    }

    /// `let`, `const`, `class` and (block-level) function declarations directly in `stmts`.
    fn hoistLexical(fs: *Fn, scope: *Scope, stmts: []*Node) Error!void {
        for (stmts) |s| {
            var n = s;
            while (n.data == .labeled) n = n.data.labeled.stmt;
            switch (n.data) {
                .var_stmt => |v| {
                    const l = v.list.data.var_list;
                    const k: BKind = switch (l.kind) {
                        .let => .let_,
                        .@"const" => .const_,
                        .@"var" => continue,
                        else => return fs.comp.unsupported(n, "`using` declarations"),
                    };
                    for (l.decls) |d| try fs.declarePattern(scope, d.data.var_decl.name, k);
                },
                .class => |cl| if (cl.name) |name| try fs.declare(scope, name.data.identifier, .class_),
                .func => |f| if (f.kind == .decl and !scope.script and scope.parent != null and !scope.names.contains(this_name)) {
                    if (f.name) |name| try fs.declare(scope, name.data.identifier, .func);
                },
                else => {},
            }
        }
    }

    fn declarePattern(fs: *Fn, scope: *Scope, pat: *Node, kind: BKind) Error!void {
        switch (pat.data) {
            .identifier => |name| try fs.declare(scope, name, kind),
            .object_pattern => |o| for (o.elems) |e| try fs.declarePattern(scope, e, kind),
            .array_pattern => |o| for (o.elems) |e| try fs.declarePattern(scope, e, kind),
            .binding_elem => |b| try fs.declarePattern(scope, b.name, kind),
            .omitted_expr => {},
            else => return fs.comp.unsupported(pat, "this binding pattern"),
        }
    }

    /// Function declarations of a body or block, made before any statement in it runs.
    fn instantiateFunctions(fs: *Fn, stmts: []*Node) Error!void {
        for (stmts) |s| {
            var n = s;
            while (n.data == .labeled) n = n.data.labeled.stmt;
            if (n.data != .func) continue;
            const f = n.data.func;
            if (f.kind != .decl) continue;
            const name = if (f.name) |nm| nm.data.identifier else "default";
            try fs.closure(n, f, .function, name);
            try fs.initName(name);
        }
    }

    // ------------------------------------------------------------------ functions

    fn closure(fs: *Fn, n: *Node, f: *Func, kind_in: Kind, name: []const u8) Error!void {
        if (f.asterisk) return fs.comp.unsupported(n, "generators (T14.4)");
        if (n.mods.async) return fs.comp.unsupported(n, "async functions (T14.4)");
        const kind: Kind = if (f.kind == .arrow) .arrow else kind_in;
        const t = try compileFunction(fs.comp, fs.scope, n, f, kind, name, fs.strict, null);
        try fs.pushFunc(t);
    }

    // ------------------------------------------------------------------ statements

    fn stmtList(fs: *Fn, list: []*Node) Error!void {
        for (list) |s| try fs.stmt(s);
    }

    fn stmt(fs: *Fn, n: *Node) Error!void {
        std.debug.assert(fs.depth == 0);
        switch (n.data) {
            .expr_stmt => |e| {
                try fs.expr(e.expr);
                if (fs.completion) |l| try fs.op16(.store, l) else try fs.op(.pop);
            },
            .var_stmt => |v| try fs.varList(v.list),
            .func => {}, // instantiated at scope entry
            .class => |cl| {
                try fs.class(n, cl, cl.name.?.data.identifier);
                try fs.initName(cl.name.?.data.identifier);
            },
            .block => |b| try fs.block(b.stmts),
            .empty_stmt, .debugger_stmt => {},
            .if_stmt => |i| {
                try fs.expr(i.cond);
                const else_jump = try fs.jump(.jump_if_false);
                try fs.stmt(i.then);
                if (i.els) |e| {
                    const end = try fs.jump(.jump);
                    fs.patch(else_jump);
                    try fs.stmt(e);
                    fs.patch(end);
                } else fs.patch(else_jump);
            },
            .return_stmt => |r| {
                if (r.expr) |e| try fs.expr(e) else try fs.op(.undef);
                try fs.emitReturn();
            },
            .throw_stmt => |t| {
                try fs.expr(t.expr);
                try fs.op(.throw);
            },
            .while_stmt => |w| {
                const ci = try fs.pushCtx(.loop);
                const top = fs.pc();
                try fs.expr(w.cond);
                const exit = try fs.jump(.jump_if_false);
                try fs.stmt(w.body);
                try fs.loopBack(ci, top);
                fs.patch(exit);
                fs.popCtx();
            },
            .do_stmt => |d| {
                const top = fs.pc();
                const ci = try fs.pushCtx(.loop);
                try fs.stmt(d.body);
                fs.patchAll(&fs.ctx.items[ci].continues, fs.pc());
                try fs.expr(d.cond);
                try fs.jumpTo(.jump_if_true, top);
                fs.popCtx();
            },
            .for_stmt => |f| try fs.forStmt(f),
            .for_in => |f| try fs.forIn(f.init, f.expr, f.body),
            .for_of => |f| {
                if (f.is_await) return fs.comp.unsupported(n, "for await (T14.4)");
                try fs.forOf(f.init, f.expr, f.body);
            },
            .break_stmt => |b| try fs.emitJump(if (b.label) |l| l.data.identifier else null, false, n),
            .continue_stmt => |b| try fs.emitJump(if (b.label) |l| l.data.identifier else null, true, n),
            .labeled => |l| {
                try fs.pending_labels.append(fs.alloc(), l.label.data.identifier);
                switch (l.stmt.data) {
                    .while_stmt, .do_stmt, .for_stmt, .for_in, .for_of, .labeled, .switch_stmt => try fs.stmt(l.stmt),
                    else => {
                        _ = try fs.pushCtx(.block);
                        try fs.stmt(l.stmt);
                        fs.popCtx();
                    },
                }
            },
            .switch_stmt => |sw| try fs.switchStmt(sw.expr, sw.clauses),
            .try_stmt => |t| try fs.tryStmt(t.block, t.catch_clause, t.finally),
            .with_stmt => return fs.comp.unsupported(n, "`with`"),
            .import_decl, .export_decl, .export_assign, .import_equals => return fs.comp.unsupported(n, "modules"),
            .interface, .type_alias, .enum_decl, .module_decl => return fs.comp.unsupported(n, "TypeScript declarations"),
            else => return fs.comp.unsupported(n, "this statement"),
        }
    }

    fn block(fs: *Fn, list: []*Node) Error!void {
        const scope = try fs.newScope(fs.scope, false);
        try fs.hoistLexical(scope, list);
        try fs.enterScope(scope);
        try fs.instantiateFunctions(list);
        try fs.stmtList(list);
        try fs.leaveScope(scope);
    }

    fn varList(fs: *Fn, list: *Node) Error!void {
        const l = list.data.var_list;
        for (l.decls) |d| {
            const v = d.data.var_decl;
            if (v.init) |init| {
                try fs.exprNamed(init, patternName(v.name));
            } else if (l.kind == .@"var") {
                continue;
            } else {
                try fs.op(.undef);
            }
            try fs.bindPattern(v.name, .init);
        }
    }

    const BindMode = enum { init, assign };

    /// Binds the value on top of the stack to `pat`, popping it.
    fn bindPattern(fs: *Fn, pat: *Node, mode: BindMode) Error!void {
        switch (pat.data) {
            .identifier => |name| if (mode == .init) try fs.initName(name) else try fs.assignName(name),
            .paren => |p| try fs.bindPattern(p.expr, mode),
            .prop_access, .elem_access => {
                // The value is on top; the reference's object (and key) go under it.
                try fs.memberTarget(pat);
                switch (pat.data) {
                    .prop_access => |pa| {
                        try fs.op(.swap);
                        try fs.propOp(.set_prop, memberName(pa.name));
                    },
                    else => {
                        try fs.op(.insert3);
                        try fs.op(.insert3);
                        try fs.op(.set_elem);
                    },
                }
                try fs.op(.pop);
            },
            .object_pattern => |o| try fs.objectPattern(o.elems, mode),
            .object_lit => |o| try fs.objectPattern(o.props, mode),
            .array_pattern => |o| try fs.arrayPattern(o.elems, mode),
            .array_lit => |o| try fs.arrayPattern(o.elems, mode),
            .binary => |b| {
                // `target = default` inside an assignment pattern.
                if (b.op != .assign) return fs.comp.unsupported(pat, "this assignment target");
                try fs.defaultValue(b.right, patternName(b.left));
                try fs.bindPattern(b.left, mode);
            },
            else => return fs.comp.unsupported(pat, "this assignment target"),
        }
    }

    /// Evaluates a member target's object (and key) onto the stack, under nothing.
    fn memberTarget(fs: *Fn, pat: *Node) Error!void {
        switch (pat.data) {
            .prop_access => |pa| try fs.expr(pa.expr),
            .elem_access => |ea| {
                try fs.expr(ea.expr);
                try fs.expr(ea.index);
                try fs.op(.to_key);
            },
            else => unreachable,
        }
    }

    /// `x === undefined ? <default> : x` for the value on top.
    fn defaultValue(fs: *Fn, def: *Node, name: ?[]const u8) Error!void {
        try fs.op(.dup);
        const skip = try fs.jump(.jump_if_not_undef);
        try fs.op(.pop);
        try fs.exprNamed(def, name);
        fs.patch(skip);
    }

    fn objectPattern(fs: *Fn, elems: []*Node, mode: BindMode) Error!void {
        // A null or undefined source is a TypeError (RequireObjectCoercible).
        try fs.op(.dup);
        const ok = try fs.jump(.jump_if_nullish);
        const over = try fs.jump(.jump);
        fs.patch(ok);
        try fs.op16(.throw_error, try fs.keyIndex("Cannot destructure a null or undefined value"));
        fs.patch(over);
        // The rest element copies what the named elements did not take; they are excluded by name.
        var taken: std.ArrayList(*Node) = .empty;
        for (elems) |e| {
            switch (e.data) {
                .binding_elem => |b| {
                    if (b.dotdotdot) {
                        try fs.restObject(taken.items);
                        try fs.bindPattern(b.name, mode);
                        continue;
                    }
                    try fs.takeProp(&taken, b.prop_name orelse b.name, b.init, b.name, mode);
                },
                .shorthand_assign => |s| try fs.takeProp(&taken, s.name, s.init, s.name, mode),
                .property_assign => |p| try fs.takeProp(&taken, p.name, null, p.value, mode),
                .spread_assign => |s| {
                    try fs.restObject(taken.items);
                    try fs.bindPattern(s.expr, mode);
                },
                else => return fs.comp.unsupported(e, "this pattern element"),
            }
        }
        try fs.op(.pop);
    }

    /// The property `pn` of the source on top (left in place) bound to `pat`, and noted as taken
    /// for a rest element.
    fn takeProp(fs: *Fn, taken: *std.ArrayList(*Node), pn: *Node, init: ?*Node, pat: *Node, mode: BindMode) Error!void {
        try fs.op(.dup);
        try fs.getByName(pn);
        try taken.append(fs.alloc(), pn);
        try fs.bindDefault(init, pat, mode);
    }

    /// Binds the value on top to `pat`, `init`'s value instead when it is undefined.
    fn bindDefault(fs: *Fn, init: ?*Node, pat: *Node, mode: BindMode) Error!void {
        if (init) |i| try fs.defaultValue(i, patternName(pat));
        try fs.bindPattern(pat, mode);
    }

    /// `{...rest}`: a copy of the source on top (left in place) without the keys already taken.
    fn restObject(fs: *Fn, taken: []*Node) Error!void {
        try fs.op(.dup);
        try fs.op(.new_object);
        try fs.op(.swap);
        try fs.op(.object_spread);
        for (taken) |pn| {
            try fs.op(.dup);
            try fs.propertyKey(pn);
            try fs.op(.delete_elem);
            try fs.op(.pop);
        }
    }

    /// `obj[name]` for a property name node, with `obj` on top.
    fn getByName(fs: *Fn, pn: *Node) Error!void {
        switch (pn.data) {
            .identifier => |id| try fs.propOp(.get_prop, id),
            else => {
                try fs.propertyKey(pn);
                try fs.op(.get_elem);
            },
        }
    }

    /// A property name as a key value (a string, or ToPropertyKey of a computed name).
    fn propertyKey(fs: *Fn, pn: *Node) Error!void {
        switch (pn.data) {
            .identifier, .private_name => |id| try fs.string(id),
            .string_lit => |s| try fs.string(s),
            .numeric_lit => |raw| {
                try fs.number(try numericValue(fs.comp, pn, raw, fs.strict));
                try fs.op(.to_key);
            },
            .computed_name => |cn| {
                try fs.expr(cn.expr);
                try fs.op(.to_key);
            },
            else => return fs.comp.unsupported(pn, "this property name"),
        }
    }

    /// A property name known at compile time, as its key text.
    fn staticKey(fs: *Fn, pn: *Node) Error!?[]const u8 {
        return switch (pn.data) {
            .identifier, .private_name => |id| id,
            .string_lit => |s| s,
            .numeric_lit => |raw| try numberKey(fs.alloc(), try numericValue(fs.comp, pn, raw, fs.strict)),
            else => null,
        };
    }

    fn arrayPattern(fs: *Fn, elems: []*Node, mode: BindMode) Error!void {
        try fs.op(.get_iterator);
        for (elems) |e| {
            switch (e.data) {
                .omitted_expr => {
                    try fs.op(.iter_value);
                    try fs.op(.pop);
                },
                .binding_elem => |b| {
                    if (b.dotdotdot) {
                        try fs.iterRest(b.name, mode);
                        continue;
                    }
                    try fs.op(.iter_value);
                    try fs.bindDefault(b.init, b.name, mode);
                },
                .spread_elem => |s| try fs.iterRest(s.expr, mode),
                else => {
                    try fs.op(.iter_value);
                    try fs.bindPattern(e, mode);
                },
            }
        }
        try fs.op(.iter_close);
    }

    fn iterRest(fs: *Fn, pat: *Node, mode: BindMode) Error!void {
        try fs.op(.dup);
        try fs.op(.iter_rest);
        try fs.bindPattern(pat, mode);
    }

    fn pushCtx(fs: *Fn, kind: CtxKind) Error!usize {
        const labels = try fs.alloc().dupe([]const u8, fs.pending_labels.items);
        fs.pending_labels.clearRetainingCapacity();
        try fs.ctx.append(fs.alloc(), .{ .kind = kind, .labels = labels, .env_level = fs.env_level });
        return fs.ctx.items.len - 1;
    }

    fn popCtx(fs: *Fn) void {
        const ctx = fs.ctx.pop().?;
        var breaks = ctx.breaks;
        fs.patchAll(&breaks, fs.pc());
    }

    fn patchAll(fs: *Fn, list: *std.ArrayList(u32), target: u32) void {
        for (list.items) |at| fs.patchTo(at, target);
        list.clearRetainingCapacity();
    }

    fn hasLabel(ctx: *const Ctx, label: []const u8) bool {
        for (ctx.labels) |l| if (std.mem.eql(u8, l, label)) return true;
        return false;
    }

    /// `break` or `continue`, through every `finally` and `for-of` it leaves.
    fn emitJump(fs: *Fn, label: ?[]const u8, is_continue: bool, n: *Node) Error!void {
        var t: usize = fs.ctx.items.len;
        while (t > 0) {
            t -= 1;
            const ctx = &fs.ctx.items[t];
            const fits = if (label) |l|
                hasLabel(ctx, l) and (!is_continue or ctx.kind == .loop or ctx.kind == .forof)
            else if (is_continue)
                ctx.kind == .loop or ctx.kind == .forof
            else
                ctx.kind == .loop or ctx.kind == .forof or ctx.kind == .switch_;
            if (fits) return fs.jumpToCtx(t, is_continue);
        }
        return fs.comp.unsupported(n, "a jump with no target");
    }

    /// Closes the iterator of every `for-of` left, innermost first, on the way out to the
    /// context `stop`; stops at the first `finally`, which takes over, and returns its index.
    fn leaveTo(fs: *Fn, stop: usize) Error!?usize {
        var i = fs.ctx.items.len;
        while (i > stop) {
            i -= 1;
            const ctx = &fs.ctx.items[i];
            switch (ctx.kind) {
                .forof => try fs.closeIter(ctx),
                .finally_ => return i,
                else => {},
            }
        }
        return null;
    }

    fn jumpToCtx(fs: *Fn, t: usize, is_continue: bool) Error!void {
        if (try fs.leaveTo(t + 1)) |i| {
            const ctx = &fs.ctx.items[i];
            try fs.popEnvs(ctx.env_level);
            const id: i32 = @intCast(ctx.jumps.items.len);
            try ctx.jumps.append(fs.alloc(), .{ .target = t, .is_continue = is_continue });
            return fs.intoFinally(i, 3 + id);
        }
        const target = &fs.ctx.items[t];
        if (target.kind == .forof and !is_continue) try fs.closeIter(target);
        try fs.popEnvs(target.env_level);
        const at = try fs.jump(.jump);
        if (is_continue) try target.continues.append(fs.alloc(), at) else try target.breaks.append(fs.alloc(), at);
    }

    /// Jumps into the `finally` of context `i`, telling it (by `completion`) where to go after.
    fn intoFinally(fs: *Fn, i: usize, completion: i32) Error!void {
        try fs.int(completion);
        try fs.op16(.store, fs.ctx.items[i].kind_local);
        try fs.ctx.items[i].fin_patches.append(fs.alloc(), try fs.jump(.jump));
    }

    fn closeIter(fs: *Fn, ctx: *const Ctx) Error!void {
        try fs.op16(.load, ctx.iter_local);
        try fs.op(.iter_close);
    }

    fn popEnvs(fs: *Fn, level: u32) Error!void {
        var k = fs.env_level;
        while (k > level) : (k -= 1) {
            try fs.byte(@backingInt(Op.pop_env));
        }
    }

    /// Returns the value on top, through every enclosing `finally` and `for-of`.
    fn emitReturn(fs: *Fn) Error!void {
        if (try fs.leaveTo(0)) |i| {
            const ctx = &fs.ctx.items[i];
            try fs.op16(.store, ctx.val_local);
            try fs.popEnvs(ctx.env_level);
            try fs.intoFinally(i, 2);
            fs.adjust(1);
            // The value went to the finally; the stack the caller sees is as if returned.
            fs.adjust(-1);
            return;
        }
        if (fs.kind.constructible()) {
            try fs.loadRaw(this_name);
            try fs.op(.ret_ctor);
        } else try fs.op(.ret);
    }

    fn forStmt(fs: *Fn, f: anytype) Error!void {
        var scope: ?*Scope = null;
        var per_iteration = false;
        if (f.init) |init| if (init.data == .var_list and init.data.var_list.kind != .@"var") {
            const s = try fs.newScope(fs.scope, false);
            const k: BKind = if (init.data.var_list.kind == .@"const") .const_ else .let_;
            for (init.data.var_list.decls) |d| try fs.declarePattern(s, d.data.var_decl.name, k);
            try fs.enterScope(s);
            scope = s;
            per_iteration = s.env and s.count > 0 and k == .let_;
        };
        if (f.init) |init| {
            if (init.data == .var_list) try fs.varList(init) else {
                try fs.expr(init);
                try fs.op(.pop);
            }
        }
        const ci = try fs.pushCtx(.loop);
        const top = fs.pc();
        var exit: ?u32 = null;
        if (f.cond) |cond| {
            try fs.expr(cond);
            exit = try fs.jump(.jump_if_false);
        }
        try fs.stmt(f.body);
        fs.patchAll(&fs.ctx.items[ci].continues, fs.pc());
        if (per_iteration) try fs.op(.clone_env);
        if (f.update) |u| {
            try fs.expr(u);
            try fs.op(.pop);
        }
        try fs.jumpTo(.jump, top);
        if (exit) |e| fs.patch(e);
        fs.popCtx();
        if (scope) |s| try fs.leaveScope(s);
    }

    /// The scope a `for (let x of …)` iteration binds in, or null for an assignment target.
    fn loopHead(fs: *Fn, init: *Node) Error!?*Scope {
        if (init.data != .var_list or init.data.var_list.kind == .@"var") return null;
        const s = try fs.newScope(fs.scope, false);
        const k: BKind = if (init.data.var_list.kind == .@"const") .const_ else .let_;
        for (init.data.var_list.decls) |d| try fs.declarePattern(s, d.data.var_decl.name, k);
        return s;
    }

    /// Binds one iteration's value (on top) to the loop head.
    fn bindHead(fs: *Fn, init: *Node) Error!void {
        if (init.data == .var_list) {
            const d = init.data.var_list.decls[0].data.var_decl;
            return fs.bindPattern(d.name, .init);
        }
        try fs.bindPattern(init, .assign);
    }

    /// The iterable (or object) of a `for-of` (`for-in`), with the head's names in their TDZ.
    fn headExpr(fs: *Fn, head: ?*Scope, e: *Node) Error!void {
        if (head) |h| try fs.enterScope(h);
        try fs.expr(e);
        if (head) |h| try fs.leaveScope(h);
    }

    /// One iteration with its value on top: bound to the head, the body run, back to `top`.
    fn iteration(fs: *Fn, head: ?*Scope, init: *Node, body: *Node, ci: usize, top: u32) Error!void {
        if (head) |h| try fs.enterScope(h);
        try fs.bindHead(init);
        try fs.stmt(body);
        if (head) |h| try fs.leaveScope(h);
        try fs.loopBack(ci, top);
    }

    /// The end of a loop body: its `continue`s and the back edge both go to `top`.
    fn loopBack(fs: *Fn, ci: usize, top: u32) Error!void {
        fs.patchAll(&fs.ctx.items[ci].continues, top);
        try fs.jumpTo(.jump, top);
    }

    fn forOf(fs: *Fn, init: *Node, iterable: *Node, body: *Node) Error!void {
        const head = try fs.loopHead(init);
        try fs.headExpr(head, iterable);
        try fs.op(.get_iterator);
        const iter = fs.newLocal();
        try fs.op16(.store, iter);
        const ci = try fs.pushCtx(.forof);
        fs.ctx.items[ci].iter_local = iter;
        const env_local = fs.newLocal();
        try fs.op16(.save_env, env_local);
        const top = fs.pc();
        try fs.op16(.load, iter);
        const done = try fs.jump(.iter_next);
        const body_start = fs.pc();
        try fs.iteration(head, init, body, ci, top);
        // A throw out of the body closes the iterator, then goes on.
        try fs.handlers.append(fs.alloc(), .{ .start = body_start, .end = fs.pc(), .target = fs.pc(), .env_local = env_local });
        fs.adjust(1);
        try fs.op16(.load, iter);
        try fs.op(.iter_close_quiet);
        fs.adjust(1);
        try fs.op(.throw);
        fs.patch(done);
        fs.popCtx();
    }

    fn forIn(fs: *Fn, init: *Node, obj: *Node, body: *Node) Error!void {
        if (init.data == .var_list) {
            const d = init.data.var_list.decls[0].data.var_decl;
            // `for (var x = init in o)`, the Annex B form.
            if (d.init) |i| {
                try fs.expr(i);
                try fs.bindPattern(d.name, .init);
            }
        }
        const head = try fs.loopHead(init);
        try fs.headExpr(head, obj);
        try fs.op(.for_in_keys);
        const keys = fs.newLocal();
        const index = fs.newLocal();
        try fs.op16(.store, keys);
        try fs.int(0);
        try fs.op16(.store, index);
        const ci = try fs.pushCtx(.loop);
        const top = fs.pc();
        try fs.byte(@backingInt(Op.for_in_next));
        try fs.operand(u16, keys);
        try fs.operand(u16, index);
        const done = fs.pc();
        try fs.operand(u32, 0);
        fs.adjust(1);
        try fs.iteration(head, init, body, ci, top);
        fs.patch(done);
        fs.popCtx();
    }

    fn switchStmt(fs: *Fn, disc: *Node, clauses: []*Node) Error!void {
        try fs.expr(disc);
        const d = fs.newLocal();
        try fs.op16(.store, d);
        const scope = try fs.newScope(fs.scope, false);
        for (clauses) |cl| try fs.hoistLexical(scope, clauseStmts(cl));
        try fs.enterScope(scope);
        for (clauses) |cl| try fs.instantiateFunctions(clauseStmts(cl));
        _ = try fs.pushCtx(.switch_);
        var body_jumps = try fs.alloc().alloc(u32, clauses.len);
        var default_index: ?usize = null;
        for (clauses, 0..) |cl, i| switch (cl.data) {
            .case_clause => |cc| {
                try fs.op16(.load, d);
                try fs.expr(cc.expr);
                try fs.op(.seq);
                body_jumps[i] = try fs.jump(.jump_if_true);
            },
            else => {
                if (default_index != null) return fs.comp.syntaxError(cl, "More than one default clause in switch statement");
                default_index = i;
            },
        };
        const no_match = try fs.jump(.jump);
        for (clauses, 0..) |cl, i| {
            if (default_index == i) fs.patch(no_match) else fs.patch(body_jumps[i]);
            try fs.stmtList(clauseStmts(cl));
        }
        if (default_index == null) fs.patch(no_match);
        fs.popCtx();
        try fs.leaveScope(scope);
    }

    fn clauseStmts(cl: *Node) []*Node {
        return switch (cl.data) {
            .case_clause => |cc| cc.stmts,
            .default_clause => |dc| dc.stmts,
            else => &.{},
        };
    }

    fn tryStmt(fs: *Fn, try_block: *Node, catch_clause: ?*Node, finally: ?*Node) Error!void {
        const env_local = fs.newLocal();
        try fs.op16(.save_env, env_local);
        var fi: ?usize = null;
        if (finally != null) {
            fi = try fs.pushCtx(.finally_);
            fs.ctx.items[fi.?].kind_local = fs.newLocal();
            fs.ctx.items[fi.?].val_local = fs.newLocal();
        }
        const start = fs.pc();
        try fs.block(try_block.data.block.stmts);
        if (catch_clause) |cc_node| {
            const cc = cc_node.data.catch_clause;
            const over = try fs.jump(.jump);
            try fs.handlers.append(fs.alloc(), .{ .start = start, .end = fs.pc(), .target = fs.pc(), .env_local = env_local });
            fs.adjust(1);
            const scope = try fs.newScope(fs.scope, false);
            if (cc.decl) |decl| try fs.declarePattern(scope, decl.data.var_decl.name, .let_);
            try fs.enterScope(scope);
            if (cc.decl) |decl| try fs.bindPattern(decl.data.var_decl.name, .init) else try fs.op(.pop);
            try fs.block(cc.block.data.block.stmts);
            try fs.leaveScope(scope);
            fs.patch(over);
        }
        const fidx = fi orelse return;
        const end = fs.pc();
        var ctx = fs.ctx.pop().?;
        try fs.int(0);
        try fs.op16(.store, ctx.kind_local);
        const normal = try fs.jump(.jump);
        try fs.handlers.append(fs.alloc(), .{ .start = start, .end = end, .target = fs.pc(), .env_local = env_local });
        _ = fidx;
        fs.adjust(1);
        try fs.op16(.store, ctx.val_local);
        try fs.int(1);
        try fs.op16(.store, ctx.kind_local);
        fs.patch(normal);
        for (ctx.fin_patches.items) |at| fs.patch(at);
        try fs.block(finally.?.data.block.stmts);
        // Dispatch on how the protected part completed.
        try fs.op16(.load, ctx.kind_local);
        const is_throw = try fs.jumpIfInt(1);
        try fs.op16(.load, ctx.kind_local);
        const is_return = try fs.jumpIfInt(2);
        var jump_cases = try fs.alloc().alloc(u32, ctx.jumps.items.len);
        for (ctx.jumps.items, 0..) |_, j| {
            try fs.op16(.load, ctx.kind_local);
            jump_cases[j] = try fs.jumpIfInt(@intCast(3 + j));
        }
        const done = try fs.jump(.jump);
        fs.patch(is_throw);
        try fs.op16(.load, ctx.val_local);
        try fs.op(.throw);
        fs.patch(is_return);
        try fs.op16(.load, ctx.val_local);
        try fs.emitReturn();
        for (ctx.jumps.items, 0..) |req, j| {
            fs.patch(jump_cases[j]);
            try fs.jumpToCtx(req.target, req.is_continue);
        }
        fs.patch(done);
        ctx.fin_patches.deinit(fs.alloc());
    }

    // ------------------------------------------------------------------ expressions

    fn expr(fs: *Fn, n: *Node) Error!void {
        return fs.exprNamed(n, null);
    }

    /// An expression; `name` names an anonymous function or class it evaluates to.
    fn exprNamed(fs: *Fn, n: *Node, name: ?[]const u8) Error!void {
        switch (n.data) {
            .identifier => |id| if (std.mem.eql(u8, id, "undefined") and fs.resolve(id) == null) try fs.op(.undef) else try fs.loadName(id),
            .numeric_lit => |raw| try fs.number(try numericValue(fs.comp, n, raw, fs.strict)),
            .string_lit, .no_subst_template => |s| try fs.string(s),
            .true_lit => try fs.op(.true),
            .false_lit => try fs.op(.false),
            .null_lit => try fs.op(.null),
            .this_expr => try fs.loadName(this_name),
            .paren => |p| try fs.exprNamed(p.expr, name),
            .as_expr => |e| try fs.expr(e.expr),
            .satisfies_expr => |e| try fs.expr(e.expr),
            .non_null => |e| try fs.expr(e.expr),
            .type_assertion => |e| try fs.expr(e.expr),
            .template_expr => |t| {
                try fs.string(t.head);
                for (t.spans) |span| {
                    const sp = span.data.template_span;
                    try fs.expr(sp.expr);
                    try fs.op(.to_string);
                    try fs.op(.add);
                    if (sp.text.len > 0) {
                        try fs.string(sp.text);
                        try fs.op(.add);
                    }
                }
            },
            .tagged_template => |t| try fs.taggedTemplate(t.tag, t.template),
            .regex_lit => |raw| {
                const slash = std.mem.lastIndexOfScalar(u8, raw, '/') orelse 0;
                try fs.byte(@backingInt(Op.regexp));
                try fs.operand(u16, try fs.strIndex(raw[1..slash]));
                try fs.operand(u16, try fs.strIndex(raw[slash + 1 ..]));
                fs.adjust(1);
            },
            .array_lit => |a| try fs.arrayLiteral(a.elems),
            .object_lit => |o| try fs.objectLiteral(o.props),
            .func => |f| try fs.closure(n, f, .function, if (f.name) |nm| nm.data.identifier else name orelse ""),
            .class => |cl| try fs.class(n, cl, if (cl.name) |nm| nm.data.identifier else name orelse ""),
            .prop_access, .elem_access, .call => try fs.chain(n, null),
            .new_expr => |ne| {
                try fs.expr(ne.callee);
                if (hasSpread(ne.args)) {
                    try fs.arrayLiteral(ne.args);
                    try fs.op(.new_spread);
                } else {
                    for (ne.args) |arg| try fs.expr(arg);
                    try fs.op16(.new, @intCast(ne.args.len));
                }
            },
            .meta_property => |m| {
                if (m.keyword == .kw_new) try fs.loadName(nt_name) else return fs.comp.unsupported(n, "import.meta");
            },
            .typeof_expr => |t| {
                if (t.expr.data == .identifier and fs.resolve(t.expr.data.identifier) == null) {
                    try fs.op16(.typeof_global, try fs.keyIndex(t.expr.data.identifier));
                } else {
                    try fs.expr(t.expr);
                    try fs.op(.typeof);
                }
            },
            .void_expr => |v| {
                try fs.expr(v.expr);
                try fs.op(.pop);
                try fs.op(.undef);
            },
            .delete_expr => |d| try fs.deleteExpr(d.expr),
            .prefix => |p| try fs.prefix(n, p.op, p.expr),
            .postfix => |p| try fs.update(p.expr, p.op == .plus2, true),
            .binary => |b| try fs.binary(n, b.left, b.op, b.right),
            .conditional => |cnd| {
                try fs.expr(cnd.cond);
                const els = try fs.jump(.jump_if_false);
                try fs.exprNamed(cnd.then, name);
                const end = try fs.jump(.jump);
                fs.patch(els);
                fs.adjust(-1);
                try fs.exprNamed(cnd.els, name);
                fs.patch(end);
            },
            .await_expr => return fs.comp.unsupported(n, "await (T14.4)"),
            .yield_expr => return fs.comp.unsupported(n, "yield (T14.4)"),
            .bigint_lit => return fs.comp.unsupported(n, "BigInt"),
            .super_expr => return fs.comp.unsupported(n, "`super` outside a call or member"),
            .import_kw => return fs.comp.unsupported(n, "import()"),
            .spread_elem => return fs.comp.unsupported(n, "a spread here"),
            else => return fs.comp.unsupported(n, "this expression"),
        }
    }

    fn arrayLiteral(fs: *Fn, elems: []*Node) Error!void {
        try fs.op16(.new_array, 0);
        for (elems) |e| switch (e.data) {
            .omitted_expr => try fs.op(.array_hole),
            .spread_elem => |s| {
                try fs.expr(s.expr);
                try fs.op(.array_spread);
            },
            else => {
                try fs.expr(e);
                try fs.op(.array_push);
            },
        };
    }

    fn objectLiteral(fs: *Fn, props: []*Node) Error!void {
        try fs.op(.new_object);
        for (props) |p| switch (p.data) {
            .property_assign => |pa| {
                if (pa.name.data == .identifier and std.mem.eql(u8, pa.name.data.identifier, "__proto__") or
                    pa.name.data == .string_lit and std.mem.eql(u8, pa.name.data.string_lit, "__proto__"))
                {
                    try fs.expr(pa.value);
                    try fs.op(.set_proto);
                    continue;
                }
                if (try fs.staticKey(pa.name)) |k| {
                    try fs.exprNamed(pa.value, k);
                    try fs.op16(.define, try fs.keyIndex(k));
                } else {
                    try fs.propertyKey(pa.name);
                    try fs.expr(pa.value);
                    try fs.op(.define_elem);
                }
            },
            .shorthand_assign => |s| {
                try fs.loadName(s.name.data.identifier);
                try fs.op16(.define, try fs.keyIndex(s.name.data.identifier));
            },
            .spread_assign => |s| {
                try fs.expr(s.expr);
                try fs.op(.object_spread);
            },
            .func => |f| try fs.method(p, f, false),
            else => return fs.comp.unsupported(p, "this object literal member"),
        };
    }

    /// A method, getter or setter of the object (or prototype, or class) on top of the stack.
    fn method(fs: *Fn, n: *Node, f: *Func, static_: bool) Error!void {
        _ = static_;
        const pn = f.name.?;
        const k = try fs.staticKey(pn);
        if (k == null) try fs.propertyKey(pn);
        const kind: Kind = switch (f.kind) {
            .getter => .getter,
            .setter => .setter,
            else => .method,
        };
        const fname = k orelse "";
        const shown = switch (kind) {
            .getter => try std.mem.concat(fs.alloc(), u8, &.{ "get ", fname }),
            .setter => try std.mem.concat(fs.alloc(), u8, &.{ "set ", fname }),
            else => fname,
        };
        try fs.closure(n, f, kind, shown);
        // The object is under the function (and the key): it is the method's home.
        try fs.setHome(if (k != null) 1 else 2);
        switch (kind) {
            .getter, .setter => {
                if (k) |key_text| {
                    try fs.byte(@backingInt(Op.define_accessor));
                    try fs.operand(u16, try fs.keyIndex(key_text));
                    try fs.byte(@intFromBool(kind == .setter));
                    fs.adjust(-1);
                } else {
                    try fs.byte(@backingInt(Op.define_accessor_elem));
                    try fs.byte(@intFromBool(kind == .setter));
                    fs.adjust(-2);
                }
            },
            else => if (k) |key_text| try fs.op16(.define, try fs.keyIndex(key_text)) else try fs.op(.define_elem),
        }
    }

    fn hasSpread(args: []*Node) bool {
        for (args) |a| if (a.data == .spread_elem) return true;
        return false;
    }

    fn pushArgs(fs: *Fn, list: []*Node) Error!?u16 {
        if (hasSpread(list)) {
            try fs.arrayLiteral(list);
            return null;
        }
        for (list) |a| try fs.expr(a);
        return @intCast(list.len);
    }

    /// Member accesses and calls, with `?.` short-circuiting the whole chain.
    fn chain(fs: *Fn, n: *Node, outer: ?*Chain) Error!void {
        var own: Chain = .{};
        const ch = outer orelse &own;
        const base = fs.depth;
        try fs.link(n, ch);
        if (outer != null or ch.exits.items.len == 0) return;
        var done: std.ArrayList(u32) = .empty;
        try done.append(fs.alloc(), try fs.jump(.jump));
        for (ch.exits.items) |e| {
            fs.patch(e.patch);
            var k = e.depth;
            while (k > base) : (k -= 1) try fs.byte(@backingInt(Op.pop));
            try fs.byte(@backingInt(Op.undef));
            try done.append(fs.alloc(), try fs.jump(.jump));
        }
        for (done.items) |at| fs.patch(at);
    }

    fn nullishExit(fs: *Fn, ch: *Chain) Error!void {
        try fs.op(.dup);
        const at = try fs.jump(.jump_if_nullish);
        try ch.exits.append(fs.alloc(), .{ .patch = at, .depth = @intCast(fs.depth) });
    }

    /// One link of a chain: the object part continues the chain, everything else starts anew.
    fn link(fs: *Fn, n: *Node, ch: *Chain) Error!void {
        switch (n.data) {
            .prop_access, .elem_access => try fs.member(n, ch, false),
            .call => |call| try fs.callExpr(n, call, ch),
            else => try fs.expr(n),
        }
    }

    /// A property or element read in a chain; for a method call (`this_too`) it leaves the
    /// object, as `this`, on top of the method.
    fn member(fs: *Fn, n: *Node, ch: *Chain, this_too: bool) Error!void {
        switch (n.data) {
            inline .prop_access, .elem_access => |a, tag| {
                const prop = tag == .prop_access;
                if (a.expr.data == .super_expr) {
                    try fs.loadName(home_name);
                    try fs.loadName(this_name);
                    if (prop) try fs.op16(.super_get, try fs.keyIndex(memberName(a.name))) else {
                        try fs.expr(a.index);
                        try fs.op(.to_key);
                        try fs.op(.super_get_elem);
                    }
                    if (this_too) try fs.loadName(this_name);
                    return;
                }
                try fs.chainPart(a.expr, ch);
                if (a.optional) try fs.nullishExit(ch);
                if (this_too) try fs.op(.dup);
                if (prop) try fs.propOp(.get_prop, memberName(a.name)) else {
                    try fs.expr(a.index);
                    try fs.op(.get_elem);
                }
                if (this_too) try fs.op(.swap);
            },
            else => unreachable,
        }
    }

    fn chainPart(fs: *Fn, n: *Node, ch: *Chain) Error!void {
        switch (n.data) {
            .prop_access, .elem_access, .call => try fs.link(n, ch),
            else => try fs.expr(n),
        }
    }

    fn callExpr(fs: *Fn, n: *Node, call: anytype, ch: *Chain) Error!void {
        const callee = call.callee;
        if (callee.data == .super_expr) return fs.superCall(call.args);
        if (callee.data == .import_kw) return fs.comp.unsupported(n, "import()");
        // The callee and `this`: a member call's object, undefined for any other.
        switch (callee.data) {
            .prop_access, .elem_access => try fs.member(callee, ch, true),
            .paren => |p| {
                // `(a.b)()` keeps `a` as `this`; `(0, a.b)()` does not.
                if (p.expr.data == .prop_access or p.expr.data == .elem_access) {
                    const inner = try fs.alloc().create(Node);
                    inner.* = n.*;
                    const call_copy = try fs.alloc().create(@TypeOf(call.*));
                    call_copy.* = call.*;
                    call_copy.callee = p.expr;
                    inner.data = .{ .call = call_copy };
                    return fs.callExpr(inner, call_copy, ch);
                }
                try fs.expr(callee);
                try fs.op(.undef);
            },
            else => {
                try fs.chainPart(callee, ch);
                try fs.op(.undef);
            },
        }
        if (call.optional) {
            // `f?.()`: the callee is under `this`.
            try fs.op(.swap);
            try fs.nullishExit(ch);
            try fs.op(.swap);
        }
        if (try fs.pushArgs(call.args)) |argc| try fs.op16(.call, argc) else try fs.op(.call_spread);
    }

    fn superCall(fs: *Fn, list: []*Node) Error!void {
        try fs.loadName(fn_name);
        try fs.loadName(nt_name);
        if (try fs.pushArgs(list)) |argc| try fs.op16(.super_call, argc) else try fs.op(.super_call_spread);
        try fs.op(.dup);
        try fs.loadRaw(this_name);
        try fs.op(.assert_uninit);
        try fs.initName(this_name);
        try fs.loadName(fn_name);
        try fs.loadRaw(this_name);
        try fs.op(.run_field_init);
    }

    fn taggedTemplate(fs: *Fn, tag: *Node, template: *Node) Error!void {
        // The tag as a callee, with its object as `this` when it is a member.
        switch (tag.data) {
            .prop_access => |pa| {
                try fs.expr(pa.expr);
                try fs.op(.dup);
                try fs.propOp(.get_prop, memberName(pa.name));
                try fs.op(.swap);
            },
            else => {
                try fs.expr(tag);
                try fs.op(.undef);
            },
        }
        var count: u16 = 0;
        switch (template.data) {
            .no_subst_template => |s| {
                try fs.string(s);
                try fs.op16(.new_array, 1);
            },
            .template_expr => |t| {
                try fs.string(t.head);
                for (t.spans) |span| try fs.string(span.data.template_span.text);
                try fs.op16(.new_array, @intCast(t.spans.len + 1));
                for (t.spans) |span| try fs.expr(span.data.template_span.expr);
                count = @intCast(t.spans.len);
            },
            else => return fs.comp.unsupported(template, "this template"),
        }
        try fs.op16(.tagged_template, count);
        fs.adjust(-1);
    }

    fn deleteExpr(fs: *Fn, target: *Node) Error!void {
        switch (target.data) {
            .prop_access => |pa| {
                try fs.expr(pa.expr);
                try fs.op16(.delete_prop, try fs.keyIndex(memberName(pa.name)));
            },
            .elem_access => {
                try fs.memberTarget(target);
                try fs.op(.delete_elem);
            },
            .identifier => |id| {
                if (fs.resolve(id) == null) try fs.op16(.delete_global, try fs.keyIndex(id)) else try fs.op(.false);
            },
            .paren => |p| try fs.deleteExpr(p.expr),
            else => {
                try fs.expr(target);
                try fs.op(.pop);
                try fs.op(.true);
            },
        }
    }

    /// A member target with its value on top, the target kept for `memberSet`.
    fn memberGet(fs: *Fn, n: *Node) Error!void {
        try fs.memberTarget(n);
        switch (n.data) {
            .prop_access => |pa| {
                try fs.op(.dup);
                try fs.propOp(.get_prop, memberName(pa.name));
            },
            else => {
                try fs.op(.dup2);
                try fs.op(.get_elem);
            },
        }
    }

    /// Writes the value on top through the member target under it.
    fn memberSet(fs: *Fn, n: *Node) Error!void {
        switch (n.data) {
            .prop_access => |pa| try fs.propOp(.set_prop, memberName(pa.name)),
            else => try fs.op(.set_elem),
        }
    }

    fn prefix(fs: *Fn, n: *Node, o: Tok, e: *Node) Error!void {
        switch (o) {
            .plus2, .minus2 => return fs.update(e, o == .plus2, false),
            else => {},
        }
        try fs.expr(e);
        try fs.op(switch (o) {
            .minus => .neg,
            .plus => .plus,
            .tilde => .bitnot,
            .bang => .not,
            else => return fs.comp.unsupported(n, "this unary operator"),
        });
    }

    /// `++x`, `x--` and friends.
    fn update(fs: *Fn, target: *Node, inc: bool, postfix: bool) Error!void {
        const step: Op = if (inc) .inc else .dec;
        switch (target.data) {
            .identifier => |id| {
                try fs.loadName(id);
                try fs.op(.plus);
                if (postfix) try fs.op(.dup);
                try fs.op(step);
                if (!postfix) try fs.op(.dup);
                try fs.assignName(id);
            },
            .prop_access, .elem_access => {
                try fs.memberGet(target);
                try fs.op(.plus);
                if (postfix) {
                    try fs.op(.dup);
                    // Under the reference: one value for `o.x`, two for `o[k]`.
                    try fs.op(if (target.data == .prop_access) .insert3 else .insert4);
                }
                try fs.op(step);
                try fs.memberSet(target);
                if (postfix) try fs.op(.pop);
            },
            .paren => |p| try fs.update(p.expr, inc, postfix),
            else => return fs.comp.unsupported(target, "this update target"),
        }
    }

    fn binaryOp(o: Tok) ?Op {
        return switch (o) {
            .plus, .plus_assign => .add,
            .minus, .minus_assign => .sub,
            .star, .star_assign => .mul,
            .slash, .slash_assign => .div,
            .percent, .percent_assign => .mod,
            .star2, .star2_assign => .exp,
            .amp, .amp_assign => .bitand,
            .pipe, .pipe_assign => .bitor,
            .caret, .caret_assign => .bitxor,
            .shl, .shl_assign => .shl,
            .shr, .shr_assign => .shr,
            .ushr, .ushr_assign => .ushr,
            .eq2 => .eq,
            .neq => .ne,
            .eq3 => .seq,
            .neq3 => .sne,
            .lt => .lt,
            .gt => .gt,
            .lte => .le,
            .gte => .ge,
            .kw_instanceof => .instanceof,
            .kw_in => .in,
            else => null,
        };
    }

    fn binary(fs: *Fn, n: *Node, left: *Node, o: Tok, right: *Node) Error!void {
        switch (o) {
            .assign => return fs.assign(left, null, right),
            .comma => {
                try fs.expr(left);
                try fs.op(.pop);
                return fs.expr(right);
            },
            .amp2, .pipe2, .qq => {
                try fs.expr(left);
                const at = try fs.shortCircuit(o);
                try fs.expr(right);
                fs.patch(at);
                return;
            },
            .amp2_assign, .pipe2_assign, .qq_assign => return fs.logicalAssign(left, o, right),
            else => {},
        }
        if (o == .plus_assign or o == .minus_assign or o == .star_assign or o == .slash_assign or o == .percent_assign or
            o == .star2_assign or o == .amp_assign or o == .pipe_assign or o == .caret_assign or o == .shl_assign or
            o == .shr_assign or o == .ushr_assign) return fs.assign(left, binaryOp(o).?, right);
        const bop = binaryOp(o) orelse return fs.comp.unsupported(n, "this binary operator");
        if (bop == .in and left.data == .private_name) return fs.comp.unsupported(n, "#x in o");
        try fs.expr(left);
        try fs.expr(right);
        try fs.op(bop);
    }

    /// With the left operand on top: jumps past the right one when it decides the result.
    fn shortCircuit(fs: *Fn, o: Tok) Error!u32 {
        try fs.op(.dup);
        const at = switch (o) {
            .amp2 => try fs.jump(.jump_if_false),
            .pipe2 => try fs.jump(.jump_if_true),
            else => blk: {
                // `??`: continue to the right operand only when the left is nullish.
                const nullish = try fs.jump(.jump_if_nullish);
                const keep = try fs.jump(.jump);
                fs.patch(nullish);
                break :blk keep;
            },
        };
        try fs.op(.pop);
        return at;
    }

    /// `left = right`, or `left bop= right`.
    fn assign(fs: *Fn, left: *Node, bop: ?Op, right: *Node) Error!void {
        switch (left.data) {
            .identifier => |id| {
                if (bop) |b| {
                    try fs.loadName(id);
                    try fs.expr(right);
                    try fs.op(b);
                } else try fs.exprNamed(right, id);
                try fs.op(.dup);
                try fs.assignName(id);
            },
            .prop_access, .elem_access => {
                if (bop) |b| {
                    try fs.memberGet(left);
                    try fs.expr(right);
                    try fs.op(b);
                } else {
                    if (memberObject(left).data == .super_expr)
                        return fs.comp.unsupported(left, if (left.data == .prop_access) "assignment to super.x" else "assignment to super[x]");
                    try fs.memberTarget(left);
                    try fs.expr(right);
                }
                try fs.memberSet(left);
            },
            .paren => |p| try fs.assign(p.expr, bop, right),
            .array_lit, .object_lit => {
                if (bop != null) return fs.comp.unsupported(left, "this assignment target");
                try fs.expr(right);
                try fs.op(.dup);
                try fs.bindPattern(left, .assign);
            },
            else => return fs.comp.unsupported(left, "this assignment target"),
        }
    }

    fn logicalAssign(fs: *Fn, left: *Node, o: Tok, right: *Node) Error!void {
        const sc: Tok = switch (o) {
            .amp2_assign => .amp2,
            .pipe2_assign => .pipe2,
            else => .qq,
        };
        switch (left.data) {
            .identifier => |id| {
                try fs.loadName(id);
                const at = try fs.shortCircuit(sc);
                try fs.exprNamed(right, id);
                try fs.op(.dup);
                try fs.assignName(id);
                fs.patch(at);
            },
            .prop_access => {
                try fs.memberGet(left);
                // obj value: keep obj under while deciding.
                const decided = try fs.shortCircuit(sc);
                try fs.expr(right);
                try fs.memberSet(left);
                const end = try fs.jump(.jump);
                fs.patch(decided);
                // obj value -> value
                fs.adjust(1);
                try fs.op(.swap);
                try fs.op(.pop);
                fs.patch(end);
            },
            .paren => |p| try fs.logicalAssign(p.expr, o, right),
            else => return fs.comp.unsupported(left, "this logical assignment target"),
        }
    }

    // ------------------------------------------------------------------ classes

    fn class(fs: *Fn, n: *Node, cl: *Class, name: []const u8) Error!void {
        if (cl.decorators.len > 0) return fs.comp.unsupported(n, "decorators");
        const scope = try fs.newScope(fs.scope, false);
        if (cl.name) |nm| try fs.declare(scope, nm.data.identifier, .const_);
        try fs.enterScope(scope);
        var heritage: ?*Node = null;
        for (cl.heritage) |h| {
            const hc = h.data.heritage_clause;
            if (hc.tok == .kw_extends and hc.types.len > 0) {
                const t = hc.types[0];
                heritage = if (t.data == .expr_with_type_args) t.data.expr_with_type_args.expr else t;
            }
        }
        // Class bodies are strict code.
        const saved_strict = fs.strict;
        fs.strict = true;
        defer fs.strict = saved_strict;
        if (heritage) |h| try fs.expr(h) else try fs.op(.uninit);
        var ctor: ?*Node = null;
        for (cl.members) |m| if (m.data == .func and m.data.func.kind == .ctor) {
            ctor = m;
        };
        const ckind: Kind = if (heritage != null) .derived_ctor else .base_ctor;
        const ct = if (ctor) |cn|
            try compileFunction(fs.comp, fs.scope, cn, cn.data.func, ckind, name, true, null)
        else
            try defaultCtor(fs.comp, fs.scope, ckind, name, n.start);
        try fs.pushFunc(ct);
        try fs.byte(@backingInt(Op.class_setup));
        try fs.byte(@intFromBool(heritage != null));
        // [ctor, proto]
        var fields: std.ArrayList(*Node) = .empty;
        var statics: std.ArrayList(*Node) = .empty;
        for (cl.members) |m| switch (m.data) {
            .func => |f| {
                if (f.kind == .ctor) continue;
                if (f.body == null) continue;
                if (m.mods.static) {
                    try fs.op(.swap);
                    try fs.method(m, f, true);
                    try fs.op(.swap);
                } else try fs.method(m, f, false);
            },
            .property_decl => |pd| {
                if (pd.name.data == .computed_name) return fs.comp.unsupported(m, "computed field names");
                if (m.mods.static) try statics.append(fs.alloc(), m) else try fields.append(fs.alloc(), m);
            },
            .static_block => try statics.append(fs.alloc(), m),
            .semicolon_member, .index_sig => {},
            else => return fs.comp.unsupported(m, "this class member"),
        };
        if (fields.items.len > 0) {
            const fi = try fieldInit(fs.comp, fs.scope, fields.items, n.start);
            // [ctor, proto] -> the initializer's home is the prototype.
            try fs.pushFunc(fi);
            try fs.setHome(1);
            try fs.op(.swap);
            try fs.op(.insert3);
            try fs.op(.set_field_init);
            try fs.op(.swap);
        }
        try fs.op(.pop);
        // §15.7.14 step 27 binds the inner name before step 31 runs the static elements.
        if (cl.name) |nm| {
            try fs.op(.dup);
            try fs.initName(nm.data.identifier);
        }
        if (statics.items.len > 0) {
            const si = try fieldInit(fs.comp, fs.scope, statics.items, n.start);
            // [ctor] -> ctor.si() with the class as `this` and as the home object.
            try fs.op(.dup);
            try fs.pushFunc(si);
            try fs.setHome(1);
            try fs.op(.swap);
            try fs.op16(.call, 0);
            try fs.op(.pop);
        }
        try fs.leaveScope(scope);
    }
};

// ---------------------------------------------------------------------- functions

fn compileFunction(comp: *Compiler, outer: ?*Scope, n: *Node, f: *Func, kind: Kind, name: []const u8, outer_strict: bool, _: ?void) Error!*Template {
    const body = f.body;
    const body_stmts: []*Node = if (body) |b| (if (b.data == .block) b.data.block.stmts else &.{}) else &.{};
    const is_expr_body = body != null and body.?.data != .block;
    var fs: Fn = .{
        .comp = comp,
        .kind = kind,
        .strict = outer_strict or hasUseStrict(body_stmts) or kind.ctor(),
        .env_mode = containsFunctionList(f.params) or (if (body) |b| containsFunction(b) else false),
    };
    const scope = try fs.newScope(outer, true);
    if (kind != .arrow) {
        try fs.declareSpecials(scope);
        if (usesArguments(body, f.params)) try fs.declare(scope, "arguments", .var_);
    }
    for (f.params) |p| try fs.declarePattern(scope, p.data.param.name, .param);
    const is_named_expr = f.kind == .expr and f.name != null;
    if (is_named_expr) try fs.declare(scope, f.name.?.data.identifier, .callee);
    if (!is_expr_body) {
        try fs.hoistVars(scope, body_stmts);
        try fs.hoistLexical(scope, body_stmts);
    }
    try fs.enterScope(scope);
    if (kind != .arrow) {
        try fs.initSpecials(scope);
        if (scope.names.contains("arguments") and (scope.names.get("arguments").?.kind == .var_)) {
            try fs.op(.arguments);
            try fs.initName("arguments");
        }
    }
    if (is_named_expr) {
        const b = scope.names.get(f.name.?.data.identifier).?;
        if (b.kind == .callee) {
            try fs.op(.callee);
            try fs.initName(f.name.?.data.identifier);
        }
    }
    var arity: u32 = 0;
    var counting = true;
    for (f.params, 0..) |p, i| {
        const param = p.data.param;
        if (param.dotdotdot) {
            counting = false;
            try fs.op16(.rest, @intCast(i));
        } else {
            try fs.op16(.arg, @intCast(i));
            if (param.init) |init| {
                counting = false;
                try fs.defaultValue(init, patternName(param.name));
            }
        }
        if (counting) arity += 1;
        try fs.bindPattern(param.name, .init);
    }
    if (kind == .base_ctor) {
        try fs.loadName(fn_name);
        try fs.loadRaw(this_name);
        try fs.op(.run_field_init);
    }
    if (is_expr_body) {
        try fs.expr(body.?);
        try fs.op(.ret);
    } else {
        try fs.instantiateFunctions(body_stmts);
        for (body_stmts) |s| try fs.stmt(s);
        try fs.op(.undef);
        try fs.emitReturn();
    }
    return fs.finish(name, arity, n.start);
}

/// The scope of a function with nothing to hoist but its specials, entered.
fn enterBare(fs: *Fn, outer: ?*Scope) Error!void {
    const scope = try fs.newScope(outer, true);
    try fs.declareSpecials(scope);
    try fs.enterScope(scope);
    try fs.initSpecials(scope);
}

/// `constructor(...args) { super(...args); }`, or the empty one of a base class.
fn defaultCtor(comp: *Compiler, outer: ?*Scope, kind: Kind, name: []const u8, start: u32) Error!*Template {
    var fs: Fn = .{ .comp = comp, .kind = kind, .strict = true, .env_mode = false };
    try enterBare(&fs, outer);
    if (kind == .derived_ctor) {
        try fs.loadName(fn_name);
        try fs.loadName(nt_name);
        try fs.op16(.rest, 0);
        try fs.op(.super_call_spread);
        try fs.initName(this_name);
    }
    try fs.loadName(fn_name);
    try fs.loadRaw(this_name);
    try fs.op(.run_field_init);
    try fs.op(.undef);
    try fs.emitReturn();
    return fs.finish(name, 0, start);
}

/// A class's field definitions (or its static elements, in order) as one function run with the
/// instance (or the class) as `this`.
fn fieldInit(comp: *Compiler, outer: ?*Scope, members: []*Node, start: u32) Error!*Template {
    var any_fn = false;
    for (members) |m| if (containsFunction(m)) {
        any_fn = true;
    };
    var fs: Fn = .{ .comp = comp, .kind = .field_init, .strict = true, .env_mode = any_fn };
    try enterBare(&fs, outer);
    for (members) |m| switch (m.data) {
        .property_decl => |pd| {
            try fs.loadName(this_name);
            const k = (try fs.staticKey(pd.name)) orelse return comp.unsupported(m, "this field name");
            if (pd.init) |init| try fs.exprNamed(init, k) else try fs.op(.undef);
            try fs.op16(.define, try fs.keyIndex(k));
            try fs.op(.pop);
        },
        .static_block => |sb| try fs.block(sb.body.data.block.stmts),
        else => {},
    };
    try fs.op(.undef);
    try fs.op(.ret);
    return fs.finish("", 0, start);
}

// ---------------------------------------------------------------------- tree queries

fn hasUseStrict(stmts: []*Node) bool {
    for (stmts) |s| {
        if (s.data != .expr_stmt or s.data.expr_stmt.expr.data != .string_lit) return false;
        const e = s.data.expr_stmt.expr;
        // The directive is the source text, not the cooked value: `"use\x20strict"` is not one.
        if (std.mem.eql(u8, e.data.string_lit, "use strict") and e.end - e.start == "'use strict'".len) return true;
    }
    return false;
}

fn containsFunctionList(list: []*Node) bool {
    for (list) |n| if (containsFunction(n)) return true;
    return false;
}

fn containsFunction(n: *Node) bool {
    switch (n.data) {
        .func, .class => return true,
        else => {},
    }
    var found = false;
    parseForEachChild(n, &found);
    return found;
}

fn parseForEachChild(n: *Node, found: *bool) void {
    const Visit = struct {
        fn f(fp: *bool, child: *Node) void {
            if (fp.*) return;
            if (containsFunction(child)) fp.* = true;
        }
    };
    forEachChild(n, found, Visit.f);
}

/// stator-ts's reflective walker, restated over the tree types this module names.
fn forEachChild(n: *Node, ctx: anytype, comptime visit: anytype) void {
    switch (n.data) {
        inline else => |payload| visitValue(payload, ctx, visit),
    }
}

fn visitValue(value: anytype, ctx: anytype, comptime visit: anytype) void {
    const T = @TypeOf(value);
    if (T == *Node) {
        visit(ctx, value);
    } else if (T == ?*Node) {
        if (value) |v| visit(ctx, v);
    } else if (T == []*Node) {
        for (value) |v| visit(ctx, v);
    } else switch (@typeInfo(T)) {
        .@"struct" => |s| inline for (s.field_names) |name| visitValue(@field(value, name), ctx, visit),
        .pointer => |p| if (p.size == .one and @typeInfo(p.child) == .@"struct") visitValue(value.*, ctx, visit),
        else => {},
    }
}

/// Whether the body (arrows included, other functions not) names `arguments`.
fn usesArguments(body: ?*Node, params: []*Node) bool {
    var found = false;
    const Visit = struct {
        fn f(fp: *bool, child: *Node) void {
            if (fp.*) return;
            switch (child.data) {
                .identifier => |id| if (std.mem.eql(u8, id, "arguments")) {
                    fp.* = true;
                },
                .func => |fun| if (fun.kind != .arrow) return,
                .class => return,
                else => {},
            }
            forEachChild(child, fp, f);
        }
    };
    for (params) |p| Visit.f(&found, p);
    if (body) |b| Visit.f(&found, b);
    return found;
}

fn patternName(pat: *Node) ?[]const u8 {
    return if (pat.data == .identifier) pat.data.identifier else null;
}

fn memberName(n: *Node) []const u8 {
    return switch (n.data) {
        .identifier, .private_name => |v| v,
        else => "",
    };
}

/// The object of a property or element access.
fn memberObject(n: *Node) *Node {
    return switch (n.data) {
        .prop_access => |pa| pa.expr,
        .elem_access => |ea| ea.expr,
        else => unreachable,
    };
}

/// A key the shape table keeps for the program's life.
fn intern(text: []const u8) [*:0]const u8 {
    return c.jsrt_shape_key(rt.string(text));
}

/// ToString of a number, as a property key spells it.
fn numberKey(a: Allocator, d: f64) Error![]const u8 {
    const s = c.jsrt_to_string(rt.number(d));
    const p = c.jsrt_shape_key_ephemeral(s);
    defer std.c.free(p);
    return a.dupe(u8, std.mem.span(p));
}

/// The value of a numeric literal's source text.
fn numericValue(comp: *Compiler, n: *Node, raw_in: []const u8, strict: bool) Error!f64 {
    _ = strict;
    var buf: [128]u8 = undefined;
    var len: usize = 0;
    for (raw_in) |ch| {
        if (ch == '_') continue;
        if (len == buf.len) return comp.unsupported(n, "a numeric literal this long");
        buf[len] = ch;
        len += 1;
    }
    const raw = buf[0..len];
    if (raw.len > 2 and raw[0] == '0') {
        const radix: ?u8 = switch (raw[1]) {
            'x', 'X' => 16,
            'o', 'O' => 8,
            'b', 'B' => 2,
            else => null,
        };
        if (radix) |r| return integerValue(raw[2..], r);
    }
    // A legacy octal literal (`017`) is octal unless a digit says it cannot be (`019`).
    if (raw.len > 1 and raw[0] == '0' and std.ascii.isDigit(raw[1])) {
        var octal = true;
        for (raw[1..]) |ch| if (ch < '0' or ch > '7') {
            octal = false;
        };
        if (octal) return integerValue(raw[1..], 8);
    }
    return std.fmt.parseFloat(f64, raw) catch comp.unsupported(n, "this numeric literal");
}

fn integerValue(digits: []const u8, radix: u8) f64 {
    var v: f64 = 0;
    for (digits) |ch| {
        const d = std.fmt.charToDigit(ch, radix) catch 0;
        v = v * @as(f64, @floatFromInt(radix)) + @as(f64, @floatFromInt(d));
    }
    return v;
}

test "compiles the constructs the interpreter runs" {
    c.jsrt_init();
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const src =
        \\var x = 1, y; let z = 2; const w = 3;
        \\function f(a, b = 2, ...r) { return a + b + r.length + arguments.length; }
        \\var g = function h() { return h; }, k = (p) => p * 2, m = { a: 1, [x]: 2, get q() { return 1; }, m() { return super.x; }, ...{} };
        \\class A { #p = 1; static s = 2; constructor() { this.v = 1; } get g() { return 1; } static { this.t = 3; } }
        \\class B extends A { constructor() { super(); } m() { return super.g; } }
        \\for (let i = 0; i < 3; i++) { if (i) continue; else break; }
        \\for (const k in m) {} for (const [a, b = 1, ...c] of [[1]]) {} for (x of []) {}
        \\L: while (false) { do { break L; } while (false); }
        \\switch (x) { case 1: let q = 1; break; default: }
        \\try { throw new Error("e"); } catch ({ message }) { } finally { x++; }
        \\try { } catch { }
        \\({ a: x, b: [y], ...m } = { a: 1, b: [2] });
        \\x ||= 1; x &&= 2; x ??= 3; m.a ||= 4; x += 1; m[x] **= 2; --m.a; m[x]++;
        \\var s = `a${x}b${y}`; var t = String.raw`x${1}`; var re = /a+/g;
        \\typeof q; delete m.a; delete m[x]; void 0; x?.y?.[z]?.(1); new A(...[1]);
        \\x = x ? y : z, x in m, x instanceof A, !x, ~x, -x, +x, 0x1F, 0o17, 0b11, 017, 1_000, 1e3, .5;
    ;
    const parsed = parse.parseScript(a, src);
    const file = switch (parsed) {
        .tree => |t| t,
        .syntax_error => |e| {
            std.debug.print("syntax error at {d}: {s}\n", .{ e.offset, e.message });
            return error.TestUnexpectedResult;
        },
    };
    const out = try compileScript(a, a, file, false);
    switch (out) {
        .template => |t| try std.testing.expect(t.code.len > 0),
        .unsupported => |u| {
            std.debug.print("unsupported at {d}: {s}\n", .{ u.offset, u.what });
            return error.TestUnexpectedResult;
        },
        .syntax_error => |e| {
            std.debug.print("early error at {d}: {s}\n", .{ e.offset, e.message });
            return error.TestUnexpectedResult;
        },
    }
}
