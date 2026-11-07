//! The C ABI the runtime calls (docs/INTERPRETER.md §1). Errors are thrown the runtime's way: the
//! exception is left pending and the call answers a value the caller checks.

const std = @import("std");
const interp = @import("stator_interp");
const c = interp.c;

/// Parses `src` with the Script goal: true, or false with a `SyntaxError` pending.
export fn jsrt_interp_parse_script(src: [*]const u8, len: usize) bool {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    switch (interp.parse.parseScript(arena.allocator(), src[0..len])) {
        .tree => return true,
        .syntax_error => |e| {
            const message = arena.allocator().dupeSentinel(u8, e.message, 0) catch @panic("out of memory");
            // jsrt_throw_error copies the message into a string before the arena goes.
            c.jsrt_throw_error(&c.jsrt_class_syntax_error, message);
            return false;
        },
    }
}

/// Runs `src` as a global script in the interpreter's realm (ECMA-262 ScriptEvaluation): its
/// completion value, or `undefined` with the exception pending.
export fn jsrt_interp_eval_script(src: [*]const u8, len: usize) c.jsrt_value {
    return interp.vm.evalScript(src[0..len]);
}
