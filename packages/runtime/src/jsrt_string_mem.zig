//! String storage: flat strings, and the append buffer behind `s += x` (docs/VALUE.md §2,
//! plan.md §9 Task 6.23, F12).
//!
//! A flat string is one pointer-free block: the JSString header, then its own code units, with
//! `data` pointing at them. Nothing in it is a reference the collector must follow, so it is an
//! atomic allocation.
//!
//! Concatenation used to copy both operands every time, so a string built by `+=` in a loop cost
//! O(n^2). Now a string that is itself the result of a concatenation grows through an append
//! buffer: one block of code units with spare capacity, and `used`, the end of the longest string
//! viewing it. Every string over a buffer is a prefix of it (`data` is the buffer's first unit), so
//! writing past `used` changes no string anyone holds. Appending onto the string whose length IS
//! `used` -- the one the loop just made -- writes in place and allocates only a header. Appending
//! onto an older, shorter prefix of the same buffer cannot (its next units belong to someone
//! else), so it copies into a fresh buffer, as any other string does. Capacity doubles, so the
//! copies cost O(n) in total.
//!
//! A buffered header holds the buffer's address in `buffer`, the block's start, so the collector
//! keeps the buffer alive through the header without depending on interior-pointer recognition.
//! The header is therefore a scanned allocation; the buffer is pointer-free and atomic.

const std = @import("std");
const concurrent = @import("jsrt_concurrent.zig");
var append_lock: std.c.pthread_mutex_t = .{};
const mem = @import("jsrt_mem.zig");
const gc = @import("jsrt_gc.zig");
const c = mem.c;

/// Below this many code units a concatenation result stays flat even when it grows a string:
/// copying a short string is cheaper than a buffer, and most concatenations are short.
const reserve_floor: u32 = 64;

const Buffer = extern struct {
    capacity: u32,
    used: u32,

    fn units(self: *Buffer) [*]u16 {
        return @ptrCast(@alignCast(@as([*]u8, @ptrCast(self)) + @sizeOf(Buffer)));
    }
};

fn atomic(bytes: usize) *anyopaque {
    return gc.allocAtomic(bytes) orelse c.jsrt_panic("out of memory allocating a string");
}

fn box(s: *c.JSString) c.jsrt_value {
    return c.JSRT_BOX(c.JSRT_TAG_STRING, @intFromPtr(s));
}

fn unbox(v: c.jsrt_value) *c.JSString {
    return @ptrFromInt(v & mem.payload_mask);
}

fn units(s: *const c.JSString) []const u16 {
    return s.data[0..s.length];
}

export fn jsrt_string_alloc(len: u32) *c.JSString {
    const block: [*]u8 = @ptrCast(atomic(@sizeOf(c.JSString) + @as(usize, len) * @sizeOf(u16)));
    const s: *c.JSString = @ptrCast(@alignCast(block));
    s.* = .{
        .length = len,
        .flags = 0,
        .data = @ptrCast(@alignCast(block + @sizeOf(c.JSString))),
        .buffer = null,
    };
    return s;
}

/// A header viewing the first `len` units of `buf`.
fn view(buf: *Buffer, len: u32) c.jsrt_value {
    const s: *c.JSString = @ptrCast(@alignCast(gc.alloc(@sizeOf(c.JSString), "string")));
    s.* = .{ .length = len, .flags = c.JSRT_STRING_GROWN, .data = buf.units(), .buffer = buf };
    return box(s);
}

fn newBuffer(len: u32) *Buffer {
    const capacity: u32 = @min(@max(len *| 2, 2 * reserve_floor), c.JSRT_MAX_STRING_LENGTH);
    const block = atomic(@sizeOf(Buffer) + @as(usize, capacity) * @sizeOf(u16));
    const buf: *Buffer = @ptrCast(@alignCast(block));
    buf.* = .{ .capacity = capacity, .used = 0 };
    return buf;
}

/// `a + b` for two strings. Past the maximum string length it leaves Node's catchable
/// `RangeError: Invalid string length` pending and answers the empty string, so a caller that
/// reads the answer before its pending check still holds a string.
export fn jsrt_string_concat(a: c.jsrt_value, b: c.jsrt_value) c.jsrt_value {
    concurrent.lock(&append_lock);
    defer concurrent.unlock(&append_lock);
    // The emitter and jsrt_op_add reach here only with two strings; anything else is a compiler bug.
    if (!c.jsrt_is(a, c.JSRT_TAG_STRING) or !c.jsrt_is(b, c.JSRT_TAG_STRING)) {
        c.jsrt_panic("jsrt_string_concat: an operand is not a string");
    }
    const sa = unbox(a);
    const sb = unbox(b);
    if (sb.length == 0) return a;
    if (sa.length == 0) return b;
    if (@as(u64, sa.length) + sb.length > c.JSRT_MAX_STRING_LENGTH) {
        c.jsrt_throw_error(&c.jsrt_class_range_error, "Invalid string length");
        return box(jsrt_string_alloc(0));
    }
    const len = sa.length + sb.length;
    if (sa.buffer) |raw| {
        const buf: *Buffer = @ptrCast(@alignCast(raw));
        if (buf.used == sa.length and len <= buf.capacity) {
            // `b` may be `a` itself, or another prefix of this buffer: it ends at or before
            // `used`, so the copy never reads a unit it writes.
            @memcpy(buf.units()[buf.used..len], units(sb));
            buf.used = len;
            return view(buf, len);
        }
    }
    if (len >= reserve_floor and (sa.buffer != null or sa.flags & c.JSRT_STRING_GROWN != 0)) {
        const buf = newBuffer(len);
        @memcpy(buf.units()[0..sa.length], units(sa));
        @memcpy(buf.units()[sa.length..len], units(sb));
        buf.used = len;
        return view(buf, len);
    }
    const out = jsrt_string_alloc(len);
    out.flags = c.JSRT_STRING_GROWN;
    @memcpy(out.data[0..sa.length], units(sa));
    @memcpy(out.data[sa.length..len], units(sb));
    return box(out);
}
