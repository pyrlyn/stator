//! The C ABI generated code and the runtime call (docs/INTERPRETER.md §3, §4), declared in
//! `packages/runtime/include/jsrt_interp.h`. Errors are thrown the runtime's way: the exception is
//! left pending and the call answers a value the caller checks.

const interp = @import("stator_interp");
const rt = interp.rt;
const Value = rt.Value;

/// `eval` and `Function` as values: compiled code calls the interpreter's own.
export fn jsrt_interp_global(name: [*:0]const u8) Value {
    return rt.c.jsrt_get_prop(interp.builtins.global(), name, null);
}

/// A direct `eval` from compiled code (jsrt_interp.h).
export fn jsrt_interp_eval_direct(source: Value, this: Value, count: u32, bindings: [*]const interp.interp.Binding) Value {
    return interp.interp.evalDirect(source, this, bindings[0..count]);
}
