//! The interpreter's bytecode (docs/INTERPRETER.md §2): a flat byte stream per function, opcodes
//! one byte, operands inline and little-endian. The machine is a stack machine over one frame
//! array — the function's locals, then its operand stack — and every operand the stack holds at a
//! statement boundary is gone by the next one, so a jump never has to rebalance it.

const std = @import("std");
const c = @import("rt.zig").c;

pub const Op = enum(u8) {
    // ---- values
    undef,
    null,
    true,
    false,
    uninit,
    /// i32 operand.
    int,
    /// u16 index into the template's numbers.
    num,
    /// u16 index into the template's strings: a fresh string value each time.
    str,
    pop,
    dup,
    /// a b -> a b a b
    dup2,
    swap,
    /// a b c -> c a b
    insert3,
    /// a b c d -> d a b c
    insert4,

    // ---- bindings
    /// u16 local.
    load,
    store,
    /// u16 local, u16 key of the name: a ReferenceError when the slot is uninitialized.
    load_checked,
    /// Same check, for an assignment to a `let` before its declaration.
    store_checked,
    /// u8 hops, u16 slot.
    load_env,
    store_env,
    /// u8 hops, u16 slot, u16 key.
    load_env_checked,
    store_env_checked,
    /// u8 hops, u16 slot: the slot holds a pointer to a compiled caller's binding (a direct
    /// `eval`'s scope, docs/INTERPRETER.md §3), read or written through.
    load_ref,
    store_ref,
    /// u16 key: the global object's property, a ReferenceError when absent.
    load_global,
    /// u16 key, u8 strict.
    store_global,
    /// u16 key: `typeof x` of an unresolved name, never a ReferenceError.
    typeof_global,
    /// u16 key: `delete x`.
    delete_global,
    /// u16 count: a new environment whose parent is the current one.
    push_env,
    pop_env,
    /// Replaces the current environment by a copy (a `for (let …)` iteration's fresh bindings).
    clone_env,
    /// u16 local: keeps the current environment for a handler.
    save_env,
    /// u16 key: a TypeError for an assignment to a constant.
    const_assign,
    /// u16 key: a global `var` or function's property, made undefined when the object lacks it.
    declare_global,
    /// Pops `this`; a ReferenceError unless it is still uninitialized (a second `super()`).
    assert_uninit,

    // ---- the call's own values
    /// u16 index.
    arg,
    /// u16 index: the arguments from there on, as an array.
    rest,
    /// The arguments as an array-like object.
    arguments,
    this_raw,
    /// `this` as a sloppy function sees it: the global object for undefined or null.
    this_sloppy,
    new_target,
    callee,
    /// The function's home object (methods): `super.x` starts at its prototype.
    home,

    // ---- properties
    /// u16 key, u16 ic.
    get_prop,
    /// obj value -> value. u16 key, u16 ic.
    set_prop,
    get_elem,
    set_elem,
    /// u16 key.
    delete_prop,
    delete_elem,
    /// key obj -> bool
    in,
    instanceof,
    /// u16 key: `super.x` — home object's prototype, read with `this` as the receiver.
    super_get,
    super_get_elem,

    // ---- operators
    add,
    sub,
    mul,
    div,
    mod,
    exp,
    bitand,
    bitor,
    bitxor,
    shl,
    shr,
    ushr,
    neg,
    plus,
    bitnot,
    not,
    typeof,
    inc,
    dec,
    eq,
    ne,
    seq,
    sne,
    lt,
    gt,
    le,
    ge,
    to_string,
    to_key,

    // ---- control
    /// u32 absolute target.
    jump,
    jump_if_false,
    jump_if_true,
    /// Pops; jumps when the value is null or undefined.
    jump_if_nullish,
    /// Pops; jumps when the value is not undefined.
    jump_if_not_undef,
    /// Pops an int; i32 operand, u32 target: jumps when they are equal.
    jump_if_int,

    // ---- calls
    /// callee this args… -> result. u16 argc.
    call,
    /// callee this array -> result
    call_spread,
    /// callee args… -> object. u16 argc.
    new,
    new_spread,
    /// args… -> this. u16 argc.
    super_call,
    super_call_spread,
    ret,
    /// value this -> the result a construction answers (§10.2.2 [[Construct]] steps 10–12).
    ret_ctor,
    throw,
    /// u16 key: a ReferenceError or a TypeError the compiler already knows the program raises.
    throw_error,

    // ---- literals
    new_object,
    /// u16 count: the top `count` values, in order, as an array.
    new_array,
    /// array value -> array
    array_push,
    array_hole,
    /// array iterable -> array
    array_spread,
    /// obj value -> obj. u16 key.
    define,
    /// obj key value -> obj
    define_elem,
    /// obj fn -> obj. u16 key, u8 setter.
    define_accessor,
    /// obj key fn -> obj. u8 setter.
    define_accessor_elem,
    /// obj src -> obj
    object_spread,
    /// obj proto -> obj
    set_proto,
    /// u16 function index.
    closure,
    /// u8 depth: the function on top gets the value `depth` slots under it as its home object.
    set_home,
    /// heritage-or-hole ctor -> ctor proto. u8 has_heritage.
    class_setup,
    /// ctor fn -> ctor: the instance-field initializer the constructor runs.
    set_field_init,
    /// Runs the field initializer on `this` (base constructors at entry, derived after super()).
    run_field_init,
    /// u16 string index, u16 flags string index.
    regexp,
    /// strings… values… -> call result. u16 count of substitutions.
    tagged_template,

    // ---- iteration
    get_iterator,
    /// iter -> value, or jumps (with the iterator popped) when done. u32 target.
    iter_next,
    /// iter -> iter value (undefined when done; keeps answering undefined after).
    iter_value,
    /// iter -> array of the rest
    iter_rest,
    iter_close,
    /// IteratorClose for a throw completion: errors from `return()` lose to the one in flight.
    iter_close_quiet,
    /// obj -> array of the for-in keys
    for_in_keys,
    /// array local-index -> value, or jumps when done. Operands: u16 array local, u16 index local, u32 target.
    for_in_next,

    // ---- suspension (docs/INTERPRETER.md §5)
    /// value -> sent mode. Suspends a generator; resumed, it pushes what `next(v)`, `throw(e)` or
    /// `return(v)` sent and the generator's `inject` mode, which the code after it dispatches on.
    yield,
    /// value -> value. Suspends an async function until the value settles; resumed by a
    /// rejection, it throws the reason here.
    await,
    /// iter received mode -> iter value kind. One step of `yield*`: kind 0 yields the value, 1
    /// ends the expression with it, 2 returns it from the generator.
    delegate,
    /// rec received mode -> rec mode result. The call half of an async generator's `yield*`
    /// step; the result is awaited, and the mode changes when the iterator lacked a method.
    async_delegate,
    /// rec mode settled -> rec value kind: `delegate`'s kinds, plus 3 to await a sync
    /// iterable's value before yielding it.
    async_delegate_step,
    /// A generator's parameters are bound: the call stops here and answers the generator object.
    gen_start,
    /// Drops every operand: a `return` injected at a `yield` leaves the expression it was in.
    reset_stack,
    /// obj -> async iterator record (§7.4.3 GetIterator with kind async).
    get_async_iterator,
    /// rec -> what `next()` answered, for an `await` to settle; a sync iterator's next value.
    async_iter_next,
    /// rec settled -> value, or jumps (both popped) when done. u32 target.
    async_iter_step,
    /// rec -> what `return()` answered, or jumps (rec popped) when there is none. u32 target.
    async_close_call,
    /// settled -> (nothing): a TypeError unless the settled `return()` result is an object.
    async_close_check,

    debugger,
};

pub const Native = struct {
    state: enum(u8) { untried, rejected, compiled } = .untried,
    code: ?*const anyopaque = null,
};

pub const Handler = struct {
    start: u32,
    end: u32,
    target: u32,
    /// The local holding the environment the handler runs in.
    env_local: u16,
};

pub const Kind = enum(u8) {
    /// A function declaration or expression: callable and constructible.
    function,
    arrow,
    method,
    getter,
    setter,
    /// A class constructor: constructible only.
    base_ctor,
    derived_ctor,
    /// A class's instance-field initializer, run with the instance as `this`.
    field_init,
    script,

    pub fn constructible(k: Kind) bool {
        return k == .function or k == .base_ctor or k == .derived_ctor;
    }

    pub fn ctor(k: Kind) bool {
        return k == .base_ctor or k == .derived_ctor;
    }
};

/// One compiled function. Immortal once made: the closures made from it hold it by a raw pointer
/// the collector does not follow, and it holds no collected value itself — string constants are
/// bytes, made into a string by each execution of `str`, and keys are interned by the shape table.
pub const Template = struct {
    code: []const u8,
    strings: []const []const u8,
    numbers: []const f64,
    keys: []const [*:0]const u8,
    funcs: []const *Template,
    ics: []c.JSRTIC,
    handlers: []const Handler,
    nlocals: u32,
    max_stack: u32,
    /// `length`: the parameters before the first default or rest.
    arity: u32,
    name: [*:0]const u8,
    kind: Kind,
    strict: bool,
    /// `function*`: a call makes the generator object and runs nothing.
    generator: bool = false,
    /// `async`: a call runs up to the first `await` and answers a promise.
    is_async: bool = false,
    /// Byte offset of the function in the source, for messages.
    start: u32,
    /// The baseline JIT's native code for this template (src/jit/), made on its first call in `jit`
    /// mode. Immortal like the template.
    jit: Native = .{},

    /// [[Construct]]: generators and async functions have none (§15.5, §15.8).
    pub fn constructible(t: *const Template) bool {
        return t.kind.constructible() and !t.generator and !t.is_async;
    }
};

pub fn read16(code: []const u8, pc: usize) u16 {
    return std.mem.readInt(u16, code[pc..][0..2], .little);
}

pub fn read32(code: []const u8, pc: usize) u32 {
    return std.mem.readInt(u32, code[pc..][0..4], .little);
}
