//! The C ABI the runtime calls (docs/INTERPRETER.md §1). Errors are thrown the runtime's way: the
//! exception is left pending and the call answers a value the caller checks.

const std = @import("std");
const interp = @import("stator_interp");

/// `JSRTClass` (jsrt_value.h), only ever passed by address.
const JSRTClass = opaque {};
extern const jsrt_class_syntax_error: JSRTClass;
extern fn jsrt_throw_error(cls: *const JSRTClass, message: [*:0]const u8) void;

/// Parses `src` with the Script goal: true, or false with a `SyntaxError` pending. T14.3 compiles
/// the tree instead of dropping it.
export fn jsrt_interp_parse_script(src: [*]const u8, len: usize) bool {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    switch (interp.parse.parseScript(arena.allocator(), src[0..len])) {
        .tree => return true,
        .syntax_error => |e| {
            const message = arena.allocator().dupeSentinel(u8, e.message, 0) catch @panic("out of memory");
            // jsrt_throw_error copies the message into a string before the arena goes.
            jsrt_throw_error(&jsrt_class_syntax_error, message);
            return false;
        },
    }
}
