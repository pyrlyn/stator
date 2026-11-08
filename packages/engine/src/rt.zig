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

pub fn int32(n: i32) Value {
    return c.JSRT_BOX(c.JSRT_TAG_INT32, @as(u32, @bitCast(n)));
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

/// A function that throws `class` with a message; the runtime copies the message.
fn thrower(comptime class: *const c.JSRTClass) fn ([*:0]const u8) void {
    return struct {
        fn throw(message: [*:0]const u8) void {
            c.jsrt_throw_error(class, message);
        }
    }.throw;
}

pub const throwType = thrower(&c.jsrt_class_type_error);
pub const throwRange = thrower(&c.jsrt_class_range_error);
pub const throwSyntax = thrower(&c.jsrt_class_syntax_error);
pub const throwReference = thrower(&c.jsrt_class_reference_error);

/// RequireObjectCoercible (§7.2.1): false, with the TypeError pending, for null and undefined.
pub fn coercible(v: Value) bool {
    if (!c.jsrt_is_nullish(v)) return true;
    throwType("Cannot convert undefined or null to object");
    return false;
}

/// A string value as source text: WTF-8, owned by the caller (`std.c.free`), or null when out
/// of memory. Unlike a property key, source text may hold U+0000.
pub fn sourceText(s: Value) ?[]u8 {
    const std = @import("std");
    const len = c.jsrt_string_length(s);
    // Three bytes per code unit at most: an astral pair is four bytes for two units.
    const buf: [*]u8 = @ptrCast(std.c.malloc(@as(usize, len) * 3 + 1) orelse return null);
    var n: usize = 0;
    var i: u32 = 0;
    while (i < len) : (i += 1) {
        var cp: u21 = c.jsrt_string_char(s, i);
        if (cp >= 0xD800 and cp <= 0xDBFF and i + 1 < len) {
            const trail = c.jsrt_string_char(s, i + 1);
            if (trail >= 0xDC00 and trail <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (trail - 0xDC00);
                i += 1;
            }
        }
        n += std.unicode.wtf8Encode(cp, buf[n .. n + 4]) catch unreachable;
    }
    return buf[0..n];
}

/// A string value's text, copied into `buf` (cut to fit).
pub fn copyText(s: Value, buf: []u8) []const u8 {
    const p = c.jsrt_shape_key_ephemeral(s);
    defer @import("std").c.free(p);
    const text = @import("std").mem.span(p);
    const n = @min(text.len, buf.len);
    @memcpy(buf[0..n], text[0..n]);
    return buf[0..n];
}

pub fn pending() bool {
    return c.jsrt_pending();
}
