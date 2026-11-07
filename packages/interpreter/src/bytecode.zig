//! The interpreter's bytecode (docs/INTERPRETER.md §2): a flat `u8` stream per function with
//! inline little-endian operands, run by a stack machine whose registers (bindings and compiler
//! temporaries) sit below its operand stack in one window. Constants, nested function templates,
//! inline caches and exception handlers sit in per-function tables of the `Proto`, which lives in
//! GC memory so a closure keeps everything its code refers to alive.

const std = @import("std");
const c = @import("jsrt");

pub const Value = c.jsrt_value;

/// Operands follow the opcode in the order listed: `r` a u16 register, `name` a u16 index into
/// `names`, `k` a u16 index into `consts`, `ic` a u16 index into `ics`, `d s` a u16 environment
/// depth and slot, `n` a u16 count, `argc` a u8, `off` an i32 offset from the end of the
/// instruction.
pub const Op = enum(u8) {
    nop,
    push_undef,
    push_null,
    push_true,
    push_false,
    /// The TDZ marker a `let`, `const` or `class` binding holds until its declaration runs.
    push_hole,
    /// k
    push_const,
    pop,
    dup,
    /// [a b] → [a b a b]
    dup2,
    /// [a b] → [b a]
    swap,

    /// r
    get_loc,
    /// r: pops into the register.
    set_loc,
    /// r: stores the top and keeps it.
    put_loc,
    /// r name: a TDZ binding's read, a ReferenceError while it holds the hole.
    get_loc_chk,
    /// r name: the TDZ check alone, before a write.
    chk_loc,
    /// d s
    get_env,
    set_env,
    put_env,
    /// d s name
    get_env_chk,
    chk_env,
    /// n: a fresh environment of n slots whose parent is the current one.
    push_scope,
    pop_scope,
    /// A per-iteration copy of the current environment (ECMA-262 CreatePerIterationEnvironment).
    clone_scope,
    /// r: the current environment into a register, or back, around a handler's entry.
    save_env,
    restore_env,

    /// name: a name no enclosing scope declares — the global lexical environment, then the global
    /// object; a ReferenceError when neither has it.
    get_global,
    /// name: `typeof x` of such a name, `undefined` when absent.
    typeof_global,
    /// name: an assignment to such a name, keeping the value; a ReferenceError for an absent name
    /// in strict code.
    put_global,
    /// name: a script's `var` (ECMA-262 GlobalDeclarationInstantiation), `undefined` unless the
    /// global object has it already.
    def_global_var,
    /// name: [fn] → [], a script's function declaration.
    def_global_func,
    /// name: a script's `let`, `const` or `class`, in its TDZ; a SyntaxError when already declared.
    def_global_lex,
    /// name: the same for a `const`, which no later assignment may change.
    def_global_const,
    /// name: [v] → [], the declaration of such a binding running.
    init_global_lex,
    /// The global object, `this` at the top of a script.
    global_this,

    /// name ic: [obj] → [value]
    get_field,
    /// name ic: [obj value] → [value]
    put_field,
    /// ic: [obj key] → [value]
    get_elem,
    /// ic: [obj key value] → [value]
    put_elem,
    /// name: [obj value] → [obj], an object literal's own data property.
    def_field,
    /// [obj key value] → [obj]
    def_elem,
    /// name: [obj getter setter] → [obj], either half `undefined` when the literal has none.
    def_accessor,
    /// [obj src] → [obj], `{...src}`.
    copy_data,
    new_object,
    /// n: [e0 … en-1] → [array]; a hole element leaves a hole.
    new_array,
    /// name: [obj] → [bool]
    delete_field,
    /// [obj key] → [bool]
    delete_elem,
    /// [source flags] → [regexp]
    regexp,

    /// k: the k-th nested template as a closure over the current environment.
    closure,
    /// argc: [fn a…] → [result]
    call,
    /// argc: [this fn a…] → [result]
    call_method,
    /// argc: [ctor a…] → [result]
    new,
    @"return",
    return_undef,
    throw,
    /// A TypeError for an assignment to a `const`.
    throw_const,

    /// off
    jmp,
    /// off: pops; jumps when falsy.
    jmp_false,
    jmp_true,
    /// off: pops; jumps when null or undefined.
    jmp_nullish,

    add,
    sub,
    mul,
    div,
    mod,
    pow,
    bitand,
    bitor,
    bitxor,
    shl,
    shr,
    ushr,
    lt,
    gt,
    le,
    ge,
    eq,
    ne,
    strict_eq,
    strict_ne,
    in,
    instanceof,
    neg,
    plus,
    not,
    bitnot,
    typeof,
    /// ToNumeric, for a postfix update's old value.
    to_numeric,
    inc,
    dec,
    /// ToString, for a template literal's substitution.
    to_string,

    /// r(type) r(value) off: records a jump through a `finally` — type 2, and the target's
    /// absolute offset as the value (§ Finally in docs/INTERPRETER.md).
    set_jump,
    /// r(type) r(value): leaves a `finally` by the completion that entered it: 0 falls through,
    /// 1 throws the value, 2 jumps to it.
    end_finally,
    /// n: an argument, `undefined` past the end.
    get_arg,
    /// n: the arguments from the n-th on, as an array.
    get_rest,
    /// The receiver, coerced for a sloppy function (ECMA-262 OrdinaryCallBindThis).
    get_this,
    /// The function being run, for a named function expression's own binding.
    get_callee,
    get_arguments,
    /// r: [obj] → [], the keys of a `for-in` into r, the next index into r+1, obj into r+2.
    for_in_start,
    /// r off: [] → [key], or jumps when the keys are done.
    for_in_next,
    /// r: [iterable] → [], its iterator into r.
    for_of_start,
    /// r off: [] → [value], or jumps when the iterator is done.
    for_of_next,
    /// r: IteratorClose of the iterator in r, for a `break` out of a `for-of`.
    iter_close,
};

/// A protected range of code and where an exception raised inside it goes. Innermost first.
pub const Handler = struct {
    start: u32,
    end: u32,
    target: u32,
    /// The operand stack depth at the `try`; the handler starts with the exception above it.
    depth: u32,
};

pub const Flags = packed struct(u8) {
    strict: bool = false,
    /// A `function` declaration or expression, which `new` can build through.
    constructible: bool = false,
    /// Reads its receiver: the call passes `this` in argument slot zero.
    has_receiver: bool = false,
    _: u5 = 0,
};

/// A function template. Allocated with `jsrt_gc_alloc`, as are its tables, so the collector's
/// masking scan reaches every constant from whichever closure or frame holds the template.
pub const Proto = struct {
    code: []const u8,
    consts: []const Value,
    /// Property keys and global names, interned (`jsrt_shape_key`): immortal, and equal by pointer
    /// to every other spelling of the same key.
    names: []const [*:0]const u8,
    protos: []const *Proto,
    ics: []c.JSRTIC,
    handlers: []const Handler,
    name: [*:0]const u8,
    arity: u32,
    nregs: u32,
    max_stack: u32,
    flags: Flags,
};

/// The stack effect of each instruction on the path that falls through, given its count operand.
pub fn stackEffect(op: Op, n: u32) i32 {
    const k: i32 = @intCast(n);
    return switch (op) {
        .nop, .swap, .put_loc, .chk_loc, .put_env, .chk_env, .push_scope, .pop_scope, .clone_scope => 0,
        .save_env, .restore_env, .put_global, .def_global_var, .def_global_lex, .def_global_const, .get_field, .delete_field => 0,
        .neg, .plus, .not, .bitnot, .typeof, .to_numeric, .inc, .dec, .to_string, .return_undef => 0,
        .throw_const, .jmp, .set_jump, .end_finally, .iter_close => 0,
        .push_undef, .push_null, .push_true, .push_false, .push_hole, .push_const, .dup, .get_loc => 1,
        .get_loc_chk, .get_env, .get_env_chk, .get_global, .typeof_global, .global_this, .new_object => 1,
        .closure, .get_arg, .get_rest, .get_this, .get_callee, .get_arguments, .for_in_next, .for_of_next => 1,
        .dup2 => 2,
        .pop, .set_loc, .set_env, .def_global_func, .init_global_lex, .put_field, .get_elem, .def_field => -1,
        .copy_data, .delete_elem, .regexp, .@"return", .throw, .jmp_false, .jmp_true, .jmp_nullish => -1,
        .add, .sub, .mul, .div, .mod, .pow, .bitand, .bitor, .bitxor, .shl, .shr, .ushr => -1,
        .lt, .gt, .le, .ge, .eq, .ne, .strict_eq, .strict_ne, .in, .instanceof => -1,
        .for_in_start, .for_of_start => -1,
        .put_elem, .def_elem, .def_accessor => -2,
        .new_array => 1 - k,
        .call, .new => -k,
        .call_method => -k - 1,
    };
}

/// The operand bytes after each opcode.
pub fn operandSize(op: Op) u32 {
    return switch (op) {
        .call, .call_method, .new => 1,
        .push_const, .get_loc, .set_loc, .put_loc, .push_scope, .save_env, .restore_env, .get_global => 2,
        .typeof_global, .put_global, .def_global_var, .def_global_func, .def_global_lex, .def_global_const => 2,
        .init_global_lex => 2,
        .get_elem, .put_elem, .def_field, .def_accessor, .new_array, .delete_field, .closure, .get_arg => 2,
        .get_rest, .for_in_start, .for_of_start, .iter_close => 2,
        .get_loc_chk, .chk_loc, .get_env, .set_env, .put_env, .get_field, .put_field, .end_finally => 4,
        .jmp, .jmp_false, .jmp_true, .jmp_nullish => 4,
        .get_env_chk, .chk_env, .for_in_next, .for_of_next => 6,
        .set_jump => 8,
        else => 0,
    };
}

test "every opcode has a size and an effect" {
    inline for (@typeInfo(Op).@"enum".field_values) |v| {
        const op: Op = @fromBackingInt(@intCast(v));
        _ = operandSize(op);
        _ = stackEffect(op, 1);
    }
}
