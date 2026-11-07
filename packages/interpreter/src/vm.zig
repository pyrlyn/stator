//! The bytecode interpreter (docs/INTERPRETER.md §3). One call runs one `Proto` in a window of
//! collected memory — its registers, then its operand stack — published as a `JSRTFrame`, so the
//! collector traces every value the code holds the way it traces compiled code's locals. An
//! interpreted function is an ordinary runtime closure whose `fn` is `entry`: compiled code, the
//! runtime's builtins and the interpreter call each other without knowing which is which.

const std = @import("std");
const c = @import("jsrt");
const bc = @import("bytecode.zig");
const compile = @import("compile.zig");
const gc = @import("gc.zig");
const parse = @import("parse.zig");
const realm = @import("realm.zig");
const scope = @import("scope.zig");

const Value = c.jsrt_value;
const Op = bc.Op;
const Proto = bc.Proto;
const Env = c.JSRTEnv;

const undef: Value = c.JSRT_UNDEFINED;
const hole: Value = c.JSRT_HOLE;

/// A pending exception, which the frame either handles or returns with.
const Throw = error{Throw};

pub fn slots(e: [*c]Env) [*]Value {
    return @ptrCast(@alignCast(&e.*._slots));
}

/// A closure running `proto` over `env`. Its own environment holds the template (as a raw
/// pointer, which the collector's mask passes through) and the closure itself, for a named
/// function expression's binding of its own name.
pub fn closureNew(proto: *const Proto, env: [*c]Env) Value {
    const own = c.jsrt_env_new(env, 2);
    slots(own)[0] = @intFromPtr(proto);
    // Every interpreted function takes a receiver slot: arrows and functions that never read
    // `this` ignore it, and one closure shape serves `new`, method calls and plain calls alike.
    var v = c.jsrt_closure_new(entry, proto.arity, proto.name, own, true);
    slots(own)[1] = v;
    if (proto.flags.constructible) v = c.jsrt_closure_constructible(v);
    return v;
}

fn entry(argc: u32, argv: [*c]const Value, env: [*c]Env) callconv(.c) Value {
    if (@frameAddress() < c.jsrt_stack_limit) return c.jsrt_stack_overflow();
    const proto: *const Proto = @ptrFromInt(slots(env)[0]);
    return run(proto, env, argc, argv);
}

/// Runs `proto` to completion: its result, or `undefined` with the exception pending.
pub fn run(proto: *const Proto, own: [*c]Env, argc: u32, argv: [*c]const Value) Value {
    const n = proto.nregs + proto.max_stack + 1;
    const w: [*]Value = @ptrCast(@alignCast(c.jsrt_gc_alloc(n * @sizeOf(Value), "interpreter frame")));
    @memset(w[0..n], undef);
    var frame: c.JSRTFrame = .{ .prev = c.jsrt_frame_top, .count = n, .slots = w, .env = own };
    c.jsrt_frame_top = &frame;
    defer c.jsrt_frame_top = frame.prev;
    var vm: Vm = .{
        .proto = proto,
        .w = w,
        .sp = proto.nregs,
        .frame = &frame,
        .own = own,
        .argc = argc,
        .argv = argv,
        .realm = realm.get(),
    };
    while (true) {
        if (vm.exec()) |v| return v else |_| if (!vm.unwind()) return undef;
    }
}

const Vm = struct {
    proto: *const Proto,
    w: [*]Value,
    sp: u32,
    pc: u32 = 0,
    /// Where the instruction being run starts, which is what a handler's range covers.
    ip: u32 = 0,
    frame: *c.JSRTFrame,
    own: [*c]Env,
    argc: u32,
    argv: [*c]const Value,
    realm: *realm.Realm,

    fn push(vm: *Vm, v: Value) void {
        vm.w[vm.sp] = v;
        vm.sp += 1;
    }

    fn pop(vm: *Vm) Value {
        vm.sp -= 1;
        return vm.w[vm.sp];
    }

    fn top(vm: *Vm) *Value {
        return &vm.w[vm.sp - 1];
    }

    fn u16op(vm: *Vm) u16 {
        defer vm.pc += 2;
        return std.mem.readInt(u16, vm.proto.code[vm.pc..][0..2], .little);
    }

    fn jumpTarget(vm: *Vm) u32 {
        const off = std.mem.readInt(i32, vm.proto.code[vm.pc..][0..4], .little);
        vm.pc += 4;
        return @intCast(@as(i64, vm.pc) + off);
    }

    fn name(vm: *Vm) [*:0]const u8 {
        return vm.proto.names[vm.u16op()];
    }

    fn env(vm: *Vm) [*c]Env {
        return vm.frame.env;
    }

    fn envSlot(vm: *Vm) *Value {
        const d = vm.u16op();
        const s = vm.u16op();
        return &slots(c.jsrt_env_up(vm.env(), d))[s];
    }

    fn unwind(vm: *Vm) bool {
        for (vm.proto.handlers) |h| {
            if (vm.ip < h.start or vm.ip >= h.end) continue;
            vm.sp = vm.proto.nregs + h.depth;
            vm.push(c.jsrt_take_exception());
            vm.pc = h.target;
            return true;
        }
        return false;
    }

    fn num(v: Value) f64 {
        return c.jsrt_to_number(v);
    }

    fn arith(vm: *Vm, op: Op) Throw!void {
        const b = vm.pop();
        const a = vm.top();
        a.* = switch (op) {
            // These opcodes are named after the runtime's operators.
            inline .add, .bitand, .bitor, .bitxor, .shl, .shr, .ushr => |o| @field(c, "jsrt_op_" ++ @tagName(o))(a.*, b),
            inline .lt, .gt, .le, .ge => |o| c.jsrt_bool(@field(c, "jsrt_op_" ++ @tagName(o))(a.*, b)),
            .pow => c.jsrt_math_pow(a.*, b),
            .eq, .ne => c.jsrt_bool(c.jsrt_loose_equals(a.*, b) == (op == .eq)),
            .strict_eq, .strict_ne => c.jsrt_bool(c.jsrt_strict_equals(a.*, b) == (op == .strict_eq)),
            .in => c.jsrt_bool(c.jsrt_in(a.*, b)),
            .instanceof => c.jsrt_bool(if (realm.errorClass(b)) |cls| c.jsrt_instanceof(a.*, cls) else c.jsrt_instanceof_ctor(a.*, b)),
            else => blk: {
                // ToNumber of the left operand runs first: a valueOf that throws stops there.
                const x = num(a.*);
                try check();
                const y = num(b);
                try check();
                break :blk c.jsrt_number(switch (op) {
                    .sub => x - y,
                    .mul => x * y,
                    .div => x / y,
                    .mod => @rem(x, y),
                    else => unreachable,
                });
            },
        };
        try check();
    }

    fn unary(vm: *Vm, op: Op) Throw!void {
        const a = vm.top();
        a.* = switch (op) {
            .not => c.jsrt_bool(!c.jsrt_truthy(a.*)),
            .bitnot => c.jsrt_op_bitnot(a.*),
            .typeof => c.jsrt_typeof(a.*),
            .to_string => c.jsrt_to_string(a.*),
            .neg => c.jsrt_number(-num(a.*)),
            .plus, .to_numeric => c.jsrt_number(num(a.*)),
            .inc => c.jsrt_number(num(a.*) + 1),
            .dec => c.jsrt_number(num(a.*) - 1),
            else => unreachable,
        };
        try check();
    }

    /// The callee of a call, which must be a function: the runtime's own call panics on anything
    /// else, where JavaScript throws.
    fn callable(v: Value) Throw!void {
        if (!c.jsrt_is(v, c.JSRT_TAG_CLOSURE)) return throwError(&c.jsrt_class_type_error, "{s} is not a function", .{typeName(v)});
    }

    /// `v`, unless it is a binding still in its TDZ; the binding's name is the next operand.
    fn initialized(vm: *Vm, v: Value) Throw!Value {
        const key = vm.name();
        if (v == hole) return tdz(key);
        return v;
    }

    /// [a b] → [f(a, b)].
    fn withTop(vm: *Vm, f: *const fn (Value, Value) callconv(.c) Value) Throw!void {
        const b = vm.pop();
        vm.top().* = f(vm.top().*, b);
        try check();
    }

    fn globalLookup(vm: *Vm, key: [*:0]const u8) Throw!?Value {
        if (vm.realm.lexical.get(key)) |l| {
            if (l.value == hole) return tdz(key);
            return l.value;
        }
        if (!c.jsrt_has_prop(vm.realm.global, key)) return null;
        const v = c.jsrt_get_prop(vm.realm.global, key, null);
        try check();
        return v;
    }

    fn exec(vm: *Vm) Throw!Value {
        const p = vm.proto;
        const code = p.code;
        while (true) {
            vm.ip = vm.pc;
            const op: Op = @fromBackingInt(@intCast(code[vm.pc]));
            vm.pc += 1;
            switch (op) {
                .nop => {},
                .push_undef => vm.push(undef),
                .push_null => vm.push(c.JSRT_NULL),
                .push_true => vm.push(c.JSRT_TRUE),
                .push_false => vm.push(c.JSRT_FALSE),
                .push_hole => vm.push(hole),
                .push_const => vm.push(p.consts[vm.u16op()]),
                .pop => vm.sp -= 1,
                .dup => vm.push(vm.top().*),
                .dup2 => {
                    vm.push(vm.w[vm.sp - 2]);
                    vm.push(vm.w[vm.sp - 2]);
                },
                .swap => std.mem.swap(Value, &vm.w[vm.sp - 1], &vm.w[vm.sp - 2]),

                .get_loc => vm.push(vm.w[vm.u16op()]),
                .set_loc => vm.w[vm.u16op()] = vm.pop(),
                .put_loc => vm.w[vm.u16op()] = vm.top().*,
                .get_loc_chk => vm.push(try vm.initialized(vm.w[vm.u16op()])),
                .chk_loc => _ = try vm.initialized(vm.w[vm.u16op()]),
                .get_env => vm.push(vm.envSlot().*),
                .set_env => vm.envSlot().* = vm.pop(),
                .put_env => vm.envSlot().* = vm.top().*,
                .get_env_chk => vm.push(try vm.initialized(vm.envSlot().*)),
                .chk_env => _ = try vm.initialized(vm.envSlot().*),
                .push_scope => vm.frame.env = c.jsrt_env_new(vm.env(), vm.u16op()),
                .pop_scope => vm.frame.env = vm.env().*.parent,
                .clone_scope => vm.frame.env = c.jsrt_env_clone(vm.env()),
                .save_env => vm.w[vm.u16op()] = @intFromPtr(vm.env()),
                .restore_env => vm.frame.env = @ptrFromInt(vm.w[vm.u16op()]),

                .get_global => {
                    const key = vm.name();
                    vm.push(try vm.globalLookup(key) orelse
                        return throwError(&c.jsrt_class_reference_error, "{s} is not defined", .{key}));
                },
                .typeof_global => {
                    const v = try vm.globalLookup(vm.name()) orelse undef;
                    vm.push(c.jsrt_typeof(v));
                },
                .put_global => {
                    const key = vm.name();
                    const v = vm.top().*;
                    if (vm.realm.lexical.getPtr(key)) |l| {
                        if (l.value == hole) return tdz(key);
                        if (l.constant) return throwError(&c.jsrt_class_type_error, "Assignment to constant variable.", .{});
                        l.value = v;
                    } else {
                        if (p.flags.strict and !c.jsrt_has_prop(vm.realm.global, key)) {
                            return throwError(&c.jsrt_class_reference_error, "{s} is not defined", .{key});
                        }
                        c.jsrt_set_prop(vm.realm.global, key, v, null);
                        try check();
                    }
                },
                .def_global_var => {
                    const key = vm.name();
                    if (!c.jsrt_has_prop(vm.realm.global, key)) c.jsrt_set_prop(vm.realm.global, key, undef, null);
                },
                .def_global_func => {
                    c.jsrt_set_prop(vm.realm.global, vm.name(), vm.pop(), null);
                    try check();
                },
                .def_global_lex, .def_global_const => {
                    const key = vm.name();
                    const gop = vm.realm.lexical.getOrPut(gc.allocator, key) catch @panic("out of memory");
                    if (gop.found_existing) {
                        return throwError(&c.jsrt_class_syntax_error, "Identifier '{s}' has already been declared", .{key});
                    }
                    gop.value_ptr.* = .{ .value = hole, .constant = op == .def_global_const };
                },
                .init_global_lex => {
                    const key = vm.name();
                    (vm.realm.lexical.getPtr(key) orelse unreachable).value = vm.pop();
                },
                .global_this => vm.push(vm.realm.global),

                .get_field => {
                    const key = vm.name();
                    const ic = &p.ics[vm.u16op()];
                    const ctor = if (key == vm.realm.constructor_key) realm.errorConstructor(vm.realm, vm.top().*) else null;
                    vm.top().* = ctor orelse c.jsrt_get_prop(vm.top().*, key, ic);
                    try check();
                },
                .get_elem => {
                    const ic = &p.ics[vm.u16op()];
                    const key = vm.pop();
                    vm.top().* = c.jsrt_dyn_index_get(vm.top().*, key, ic);
                    try check();
                },
                // An assignment answers the value; a definition leaves the object being built.
                .put_field, .put_elem, .def_field, .def_elem => {
                    const key = if (op == .put_field or op == .def_field) vm.name() else null;
                    const ic: ?*c.JSRTIC = if (op == .put_field or op == .put_elem) &p.ics[vm.u16op()] else null;
                    const v = vm.pop();
                    if (key) |k| c.jsrt_set_prop(vm.top().*, k, v, ic) else {
                        const k = vm.pop();
                        c.jsrt_dyn_index_set(vm.top().*, k, v, ic);
                    }
                    try check();
                    if (op == .put_field or op == .put_elem) vm.top().* = v;
                },
                .def_accessor => {
                    const key = vm.name();
                    const set = vm.pop();
                    const get = vm.pop();
                    c.jsrt_define_accessor(vm.top().*, key, get, set);
                    try check();
                },
                .copy_data => try vm.withTop(c.jsrt_object_assign),
                .new_object => vm.push(c.jsrt_dynobj_new()),
                .new_array => {
                    const n = vm.u16op();
                    vm.sp -= n;
                    vm.w[vm.sp] = c.jsrt_array_new(n, vm.w + vm.sp);
                    vm.sp += 1;
                },
                .delete_field, .delete_elem => {
                    const key = if (op == .delete_field) realm.nameValue(vm.name()) else vm.pop();
                    const ok = c.jsrt_delete(vm.top().*, key);
                    try check();
                    vm.top().* = c.jsrt_bool(ok);
                },
                .regexp => try vm.withTop(c.jsrt_regexp_new),

                .closure => vm.push(closureNew(p.protos[vm.u16op()], vm.env())),
                .call, .call_method, .new => {
                    const argc = code[vm.pc];
                    vm.pc += 1;
                    const args = vm.w + (vm.sp - argc);
                    const callee = vm.w[vm.sp - argc - 1];
                    const result = switch (op) {
                        .call => blk: {
                            try callable(callee);
                            break :blk c.jsrt_call_at(callee, argc, args, null);
                        },
                        .call_method => blk: {
                            try callable(callee);
                            break :blk c.jsrt_call_with_this(callee, vm.w[vm.sp - argc - 2], argc, args);
                        },
                        else => c.jsrt_construct(callee, argc, args),
                    };
                    try check();
                    vm.sp -= argc + @as(u32, if (op == .call_method) 1 else 0);
                    vm.top().* = result;
                },
                .@"return" => return vm.pop(),
                .return_undef => return undef,
                .throw => {
                    c.jsrt_throw(vm.pop());
                    return error.Throw;
                },
                .throw_const => return throwError(&c.jsrt_class_type_error, "Assignment to constant variable.", .{}),

                .jmp => vm.pc = vm.jumpTarget(),
                .jmp_false, .jmp_true => {
                    const t = vm.jumpTarget();
                    if (c.jsrt_truthy(vm.pop()) == (op == .jmp_true)) vm.pc = t;
                },
                .jmp_nullish => {
                    const t = vm.jumpTarget();
                    if (c.jsrt_is_nullish(vm.pop())) vm.pc = t;
                },

                .add, .sub, .mul, .div, .mod, .pow, .bitand, .bitor, .bitxor, .shl, .shr, .ushr => try vm.arith(op),
                .lt, .gt, .le, .ge, .eq, .ne, .strict_eq, .strict_ne, .in, .instanceof => try vm.arith(op),
                .neg, .plus, .not, .bitnot, .typeof, .to_numeric, .inc, .dec, .to_string => try vm.unary(op),

                .set_jump => {
                    const rt = vm.u16op();
                    const rv = vm.u16op();
                    const t = vm.jumpTarget();
                    vm.w[rt] = c.jsrt_number(2);
                    vm.w[rv] = c.jsrt_number(@floatFromInt(t));
                },
                .end_finally => {
                    const rt = vm.u16op();
                    const rv = vm.u16op();
                    switch (@as(u32, @intFromFloat(c.jsrt_number_value(vm.w[rt])))) {
                        0 => {},
                        1 => {
                            c.jsrt_throw(vm.w[rv]);
                            return error.Throw;
                        },
                        else => vm.pc = @intFromFloat(c.jsrt_number_value(vm.w[rv])),
                    }
                },
                // Argument zero is the receiver (closureNew).
                .get_arg => {
                    const i = @as(u32, vm.u16op()) + 1;
                    vm.push(if (i < vm.argc) vm.argv[i] else undef);
                },
                .get_rest => {
                    const from = @as(u32, vm.u16op()) + 1;
                    vm.push(c.jsrt_args_rest(vm.argc, vm.argv, @min(from, vm.argc)));
                },
                .get_this => {
                    const this = if (vm.argc > 0) vm.argv[0] else undef;
                    // OrdinaryCallBindThis: sloppy code sees the global object for a missing one.
                    vm.push(if (!p.flags.strict and c.jsrt_is_nullish(this)) vm.realm.global else this);
                },
                .get_callee => vm.push(slots(vm.own)[1]),
                .get_arguments => vm.push(if (vm.argc > 1) c.jsrt_array_new(vm.argc - 1, vm.argv + 1) else c.jsrt_array_new(0, null)),

                .for_in_start => {
                    const r = vm.u16op();
                    const obj = vm.pop();
                    vm.w[r + 2] = obj;
                    vm.w[r + 1] = c.jsrt_number(0);
                    vm.w[r] = if (c.jsrt_is_nullish(obj)) c.jsrt_array_new(0, null) else c.jsrt_object_for_in_keys(obj);
                    try check();
                },
                .for_in_next => {
                    const r = vm.u16op();
                    const t = vm.jumpTarget();
                    const keys = c.jsrt_as_array(vm.w[r]);
                    const obj = vm.w[r + 2];
                    var i: u32 = @intFromFloat(c.jsrt_number_value(vm.w[r + 1]));
                    // A key deleted before the loop reaches it is skipped (§14.7.5.10).
                    const key = while (i < keys.*.length) {
                        const k = keys.*.elements[i];
                        i += 1;
                        if (!c.jsrt_is_object(obj) or c.jsrt_in(k, obj)) break k;
                    } else null;
                    vm.w[r + 1] = c.jsrt_number(@floatFromInt(i));
                    if (key) |k| vm.push(k) else vm.pc = t;
                },
                .for_of_start => {
                    const r = vm.u16op();
                    vm.w[r] = c.jsrt_get_iterator(vm.pop());
                    try check();
                },
                .for_of_next => {
                    const r = vm.u16op();
                    const t = vm.jumpTarget();
                    var out: Value = undef;
                    if (c.jsrt_iterator_step(vm.w[r], &out)) {
                        vm.push(out);
                    } else {
                        try check();
                        vm.pc = t;
                    }
                },
                .iter_close => {
                    c.jsrt_iterator_close(vm.w[vm.u16op()]);
                    try check();
                },
            }
        }
    }
};

fn check() Throw!void {
    if (c.jsrt_pending()) return error.Throw;
}

fn throwError(cls: *const c.JSRTClass, comptime fmt: []const u8, args: anytype) Throw {
    var buf: [512]u8 = undefined;
    const message = std.fmt.bufPrintSentinel(&buf, fmt, args, 0) catch blk: {
        buf[buf.len - 1] = 0;
        break :blk buf[0 .. buf.len - 1 :0];
    };
    c.jsrt_throw_error(cls, message.ptr);
    return error.Throw;
}

fn tdz(key: [*:0]const u8) Throw {
    return throwError(&c.jsrt_class_reference_error, "Cannot access '{s}' before initialization", .{key});
}

fn typeName(v: Value) []const u8 {
    if (v == undef) return "undefined";
    if (v == c.JSRT_NULL) return "null";
    if (c.jsrt_is(v, c.JSRT_TAG_STRING)) return "string";
    if (c.jsrt_is_number(v)) return "number";
    if (v == c.JSRT_TRUE or v == c.JSRT_FALSE) return "boolean";
    return "object";
}

/// ECMA-262 ScriptEvaluation of `src` in the realm: the completion value, or `undefined` with the
/// exception pending — a `SyntaxError` for source that does not parse, and an `Error` naming the
/// construct for source this slice of the interpreter does not compile yet.
pub fn evalScript(src: []const u8) Value {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const file = switch (parse.parseScript(a, src)) {
        .tree => |t| t,
        .syntax_error => |e| {
            throwError(&c.jsrt_class_syntax_error, "{s}", .{e.message}) catch {};
            return undef;
        },
    };
    const res = scope.resolve(a, file.root, false) catch @panic("out of memory");
    var comp: compile.Compiler = .{ .a = a, .res = &res };
    const proto = compile.compileScript(&comp, file.root) catch |err| switch (err) {
        error.OutOfMemory => @panic("out of memory"),
        error.Unsupported => {
            const what = comp.unsupported.?.what;
            throwError(&c.jsrt_class_error, "not yet supported by the interpreter: {s}", .{what}) catch {};
            return undef;
        },
    };
    return run(proto, null, 0, null);
}

// ---------------------------------------------------------------- tests

const testing = std.testing;

// The tests share one realm, as scripts do: a global `let` or `const` name is used once.

var initialized = false;

fn evalForTest(src: []const u8) Value {
    if (!initialized) {
        c.jsrt_init();
        initialized = true;
    }
    return evalScript(src);
}

/// The script's completion value, failing the test when it throws.
fn evalOk(src: []const u8) !Value {
    const v = evalForTest(src);
    if (c.jsrt_pending()) {
        std.debug.print("threw: {s}\n  in: {s}\n", .{ c.jsrt_string_to_cstr(c.jsrt_to_string(c.jsrt_take_exception())), src });
        return error.TestUnexpectedResult;
    }
    return v;
}

fn expectNumber(want: f64, src: []const u8) !void {
    const v = try evalOk(src);
    try testing.expect(c.jsrt_is_number(v));
    try testing.expectEqual(want, c.jsrt_number_value(v));
}

fn expectString(want: []const u8, src: []const u8) !void {
    const v = try evalOk(src);
    try testing.expectEqualStrings(want, std.mem.span(c.jsrt_string_to_cstr(c.jsrt_to_string(v))));
}

/// The script throws an error whose `String()` is `want`.
fn expectThrow(want: []const u8, src: []const u8) !void {
    _ = evalForTest(src);
    try testing.expect(c.jsrt_pending());
    const e = c.jsrt_take_exception();
    try testing.expectEqualStrings(want, std.mem.span(c.jsrt_string_to_cstr(c.jsrt_to_string(e))));
}

test "expressions" {
    try expectNumber(7, "1 + 2 * 3");
    try expectNumber(1, "7 % 3");
    try expectNumber(-1, "-7 % 3 + 0");
    try expectNumber(1024, "2 ** 10");
    try expectNumber(5, "(1, 2, 5)");
    try expectNumber(3, "true ? 3 : 4");
    try expectString("ab1", "'a' + 'b' + 1");
    try expectString("x=3!", "var x = 3; `x=${x}!`");
    try expectString("number", "typeof 1");
    try expectString("undefined", "typeof notDeclaredAnywhere");
    try expectNumber(6, "var a = 0; a ||= 6; a &&= a; a ??= 9; a");
    try expectNumber(2, "var i = 1; i++; i");
    try expectNumber(1, "var j = 1; j++");
    try expectNumber(3, "var o = { n: 2 }; ++o.n");
    try expectNumber(-1, "~0");
    try expectNumber(4, "1 << 2");
    try expectString("true", "String(1 == '1' && 1 !== '1')");
}

test "objects, arrays and members" {
    try expectNumber(3, "var o = { a: 1, b: { c: 2 } }; o.a + o.b.c");
    try expectNumber(5, "var o = { get x() { return 5; } }; o.x");
    try expectNumber(9, "var o = { k: 4, m() { return this.k + 5; } }; o.m()");
    try expectNumber(3, "var xs = [1, 2, 3]; xs.length");
    try expectNumber(2, "var xs = [1, 2, 3]; xs[1]");
    try expectString("undefined", "var o = null; String(o?.a.b.c)");
    try expectNumber(1, "var o = { f() { return 1; } }; o.f?.()");
    try expectString("false", "var o = { a: 1 }; delete o.a; String('a' in o)");
    try expectNumber(2, "var k = 'z'; var o = { [k]: 2 }; o.z");
    try expectNumber(3, "var o = { a: 1 }; var p = { ...o, b: 2 }; p.a + p.b");
}

test "bindings and scopes" {
    try expectNumber(3, "let la = 1; { let la = 2; } const lb = 2; la + lb");
    try expectThrow("ReferenceError: Cannot access 'tdz' before initialization", "tdz; let tdz = 1;");
    try expectThrow("TypeError: Assignment to constant variable.", "const frozen = 1; frozen = 2;");
    try expectThrow("ReferenceError: nope is not defined", "nope + 1");
    try expectThrow("ReferenceError: undeclared is not defined", "'use strict'; undeclared = 1;");
    try expectNumber(5, "sloppyGlobal = 5; sloppyGlobal");
    try expectNumber(10, "hoisted(); function hoisted() { return 10; }");
}

test "control flow" {
    try expectNumber(10, "var s = 0; for (var i = 0; i < 5; i++) s += i; s");
    try expectNumber(6, "var s = 0, i = 0; while (true) { i++; if (i > 3) break; s += i; } s");
    try expectNumber(9, "var s = 0, i = 0; do { s += i; i++; } while (i < 3); s * 3");
    try expectNumber(4, "var n = 0; outer: for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) { if (j == 2) continue outer; if (i == 2) break outer; n++; } n");
    try expectString("two", "var r; switch (2) { case 1: r = 'one'; break; case 2: r = 'two'; break; default: r = 'other'; } r");
    try expectString("ab", "var r = ''; switch (3) { default: r += 'a'; case 4: r += 'b'; } r");
    try expectString("ab", "var r = ''; for (var k in { a: 1, b: 2 }) r += k; r");
    try expectNumber(6, "var s = 0; for (const x of [1, 2, 3]) s += x; s");
    try expectNumber(3, "var fs = []; for (let i = 0; i < 3; i++) fs.push(() => i); fs[0]() + fs[1]() + fs[2]()");
}

test "functions" {
    try expectNumber(55, "function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } fib(10)");
    try expectNumber(3, "function mk() { var n = 0; return () => ++n; } var f = mk(); f(); f(); f()");
    try expectNumber(7, "function f(a, b = 5) { return a + b; } f(2)");
    try expectNumber(3, "function f(...xs) { return xs.length; } f(1, 2, 3)");
    try expectNumber(2, "function f() { return arguments.length; } f(1, 2)");
    try expectNumber(120, "var fact = function me(n) { return n <= 1 ? 1 : n * me(n - 1); }; fact(5)");
    try expectNumber(4, "function P(x) { this.x = x; } var p = new P(4); p.x");
    try expectString("f", "function f() {} f.name");
    try expectNumber(2, "function f(a, b) {} f.length");
    try expectNumber(8, "var o = { v: 8, f() { return (() => this.v)(); } }; o.f()");
    try expectThrow("TypeError: number is not a function", "var n = 1; n();");
}

test "exceptions" {
    try expectString("caught boom", "var r; try { throw 'boom'; } catch (e) { r = 'caught ' + e; } r");
    try expectString("tf", "var r = ''; try { r += 't'; } finally { r += 'f'; } r");
    try expectNumber(2, "function f() { try { return 1; } finally { return 2; } } f()");
    try expectString("xyz", "var r = ''; function f() { try { r += 'x'; return; } finally { r += 'y'; } } f(); r += 'z'; r");
    try expectString("1f", "var r = ''; for (var i = 0; i < 3; i++) { try { if (i == 1) break; } finally { r += 'f'; } } r = i + r.slice(1); r");
    try expectString("Error: inner", "var m; try { try { throw new Error('inner'); } finally { m = 1; } } catch (e) { m = String(e); } m");
    try expectString("RangeError", "function r() { return r(); } var n; try { r(); } catch (e) { n = e.name; } n");
    try expectString("true true", "var x; try { null.f; } catch (e) { x = e; } String(x.constructor === TypeError) + ' ' + (new RangeError('r').constructor === RangeError)");
    try expectThrow("Error: not yet supported by the interpreter: a class", "class A {}");
    try expectThrow("SyntaxError: Variable declaration expected.", "var = ;");
}

test "values the code holds survive collections" {
    try expectNumber(19900000,
        \\var keep = [];
        \\for (var i = 0; i < 200000; i++) {
        \\  let n = i;
        \\  var o = { s: 'x' + i, f() { return n; } };
        \\  if (i % 1000 == 0) keep.push(o);
        \\}
        \\var sum = 0;
        \\for (var j = 0; j < keep.length; j++) sum += keep[j].f() + keep[j].s.length * 0;
        \\sum
    );
}
