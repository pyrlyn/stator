//! The runtime's C ABI as the interpreter sees it: `jsrt_c` is `zig translate-c` of the same
//! header the Zig memory core compiles against (packages/runtime/src/jsrt_c.h), so a layout the
//! runtime changes is a compile error here rather than a mismatch at run time.

pub const c = @import("jsrt_c");
pub const Value = c.jsrt_value;

pub const undefined_value: Value = c.JSRT_UNDEFINED;
pub const null_value: Value = c.JSRT_NULL;
pub const true_value: Value = c.JSRT_TRUE;
pub const false_value: Value = c.JSRT_FALSE;
/// A `let`, `const` or `class` binding before its declaration runs (the TDZ). It never leaves a
/// register or an environment slot: every read of a binding that can hold it checks for it.
pub const uninitialized: Value = c.JSRT_BOX(c.JSRT_TAG_UNDEFINED, 2);

pub fn number(d: f64) Value {
    return c.jsrt_number(d);
}

pub fn boolean(b: bool) Value {
    return if (b) true_value else false_value;
}

pub fn string(bytes: []const u8) Value {
    return c.jsrt_string_from_utf8(bytes.ptr, bytes.len);
}

pub fn isObjectLike(v: Value) bool {
    const t = c.jsrt_tag(v);
    return !c.jsrt_is_double(v) and (t == c.JSRT_TAG_OBJECT or t == c.JSRT_TAG_ARRAY or t == c.JSRT_TAG_CLOSURE);
}

pub fn is(v: Value, tag: c_int) bool {
    return c.jsrt_is(v, @intCast(tag));
}

pub fn throwType(message: [*:0]const u8) void {
    c.jsrt_throw_error(&c.jsrt_class_type_error, message);
}

pub fn throwRange(message: [*:0]const u8) void {
    c.jsrt_throw_error(&c.jsrt_class_range_error, message);
}

pub fn throwSyntax(message: [*:0]const u8) void {
    c.jsrt_throw_error(&c.jsrt_class_syntax_error, message);
}

pub fn throwReference(message: [*:0]const u8) void {
    c.jsrt_throw_error(&c.jsrt_class_reference_error, message);
}

pub fn pending() bool {
    return c.jsrt_pending();
}
