//! `ArrayBuffer` and `Uint8Array` (plan.md T11.1, docs/VALUE.md §4.19): the byte storage, the
//! constructor forms, element reads and writes, `subarray`/`slice`/`set`, `ArrayBuffer.slice`, and
//! the dynamic tier's view of both classes. The layouts are jsrt_value.h's; the C side keeps only
//! the hooks that live where the C already dispatches (property reads, iteration, printing).
//!
//! A buffer is two blocks: the header (the collected kind, so its `data` word is a traced edge) and
//! the bytes (the POINTER-FREE kind, never scanned). A view is one header whose `buffer` word is the
//! edge to the bytes' owner. Every function reaches the bytes through that edge, never a cached
//! interior pointer, so a view keeps its buffer alive and a subarray shares it.
//!
//! Errors are Node's (V8's) wording, raised through the pending mailbox like every other runtime
//! throw: a RangeError for a length or offset ToIndex refuses, a TypeError for a receiver that is
//! not the class the method belongs to. A receiver can only be wrong when a type annotation lied
//! across a boundary (AGENTS.md golden rule 4), and that must be a catchable error, not a crash.

const std = @import("std");
const mem = @import("jsrt_mem.zig");
const gc = @import("jsrt_gc.zig");
const alloc = @import("jsrt_alloc.zig");
const c = mem.c;

const Value = c.jsrt_value;
const Buffer = c.JSRTArrayBuffer;
const View = c.JSRTTypedArray;
const undefined_value: Value = c.JSRT_UNDEFINED;

/// 2^53 - 1: the largest length ToIndex accepts (ECMA-262 §7.1.22).
const max_index: f64 = 9007199254740991.0;

fn descriptor(comptime name: [*:0]const u8) c.JSRTClass {
    var k = std.mem.zeroes(c.JSRTClass);
    k.name = name;
    return k;
}

export const jsrt_class_arraybuffer: c.JSRTClass = descriptor("ArrayBuffer");
export const jsrt_class_uint8array: c.JSRTClass = descriptor("Uint8Array");

// ------------------------------------------------------------------------- value plumbing

fn classOf(v: Value) ?*const c.JSRTClass {
    if (!c.jsrt_is(v, c.JSRT_TAG_OBJECT)) return null;
    const o: *const c.JSRTObject = @ptrCast(@alignCast(c.jsrt_ptr(v)));
    return o.cls;
}

fn asClass(comptime T: type, v: Value, cls: *const c.JSRTClass) ?*T {
    if (classOf(v) != cls) return null;
    return @ptrCast(@alignCast(c.jsrt_ptr(v)));
}

fn asBuffer(v: Value) ?*Buffer {
    return asClass(Buffer, v, &jsrt_class_arraybuffer);
}

fn asView(v: Value) ?*View {
    return asClass(View, v, &jsrt_class_uint8array);
}

fn box(p: anytype) Value {
    return c.JSRT_BOX(c.JSRT_TAG_OBJECT, @intFromPtr(p));
}

fn bytesOf(view: *const View) []u8 {
    return view.buffer.*.data[view.byte_offset..][0..view.length];
}

/// ToNumber. A conversion that throws leaves the exception pending; every caller checks.
fn toNumber(v: Value) f64 {
    return if (c.jsrt_is_number(v)) c.jsrt_number_value(v) else c.jsrt_to_number(v);
}

/// ToIntegerOrInfinity on an already-converted number: NaN is 0, and -0 is +0.
fn toInteger(d: f64) f64 {
    if (std.math.isNan(d)) return 0;
    const t = @trunc(d);
    return if (t == 0) 0 else t;
}

/// ToUint8 (§7.1.11): modulo 2^8 of the truncated value; NaN and the infinities are 0.
fn toUint8(d: f64) u8 {
    if (!std.math.isFinite(d)) return 0;
    return @intFromFloat(@mod(@trunc(d), 256.0));
}

/// The result of ToIndex: `number` is ToNumber of the argument (what V8's length message prints),
/// `integer` its ToIntegerOrInfinity, and `ok` whether that is within [0, 2^53 - 1].
const Index = struct {
    number: f64,
    integer: f64,
    ok: bool,

    fn size(self: Index) usize {
        return @intFromFloat(self.integer);
    }
};

/// ToIndex (§7.1.22). `null` means a conversion threw and the exception is pending.
fn toIndex(v: Value) ?Index {
    if (v == undefined_value) return .{ .number = 0, .integer = 0, .ok = true };
    const d = toNumber(v);
    if (c.jsrt_pending()) return null;
    const i = toInteger(d);
    return .{ .number = d, .integer = i, .ok = i >= 0 and i <= max_index };
}

/// A relative bound (`slice`/`subarray`): negative counts back from `len`, the result is clamped
/// to [0, len], and `undefined` is `default`. `null` means a conversion threw.
fn relative(v: Value, len: usize, default: usize) ?usize {
    if (v == undefined_value) return default;
    const d = toNumber(v);
    if (c.jsrt_pending()) return null;
    const i = toInteger(d);
    const n: f64 = @floatFromInt(len);
    const at = if (i < 0) @max(n + i, 0) else @min(i, n);
    return @intFromFloat(at);
}

/// The `[start, end)` window of a `slice`/`subarray` over `len` elements, empty when the bounds
/// cross. `null` means a conversion threw.
const Window = struct { first: usize, len: usize };

fn window(start: Value, end: Value, len: usize) ?Window {
    const first = relative(start, len, 0) orelse return null;
    const final = relative(end, len, len) orelse return null;
    return .{ .first = first, .len = if (final > first) final - first else 0 };
}

/// ToLength (§7.1.20) of an array-like's `length`.
fn toLength(v: Value) ?usize {
    const d = toNumber(v);
    if (c.jsrt_pending()) return null;
    const i = toInteger(d);
    if (i <= 0) return 0;
    return @intFromFloat(@min(i, max_index));
}

/// `jsrt_to_string` of a number, as bytes: a number's ToString is ASCII.
fn numberText(d: f64, buf: []u8) []const u8 {
    const text = c.jsrt_to_string(c.jsrt_number(d));
    const len = @min(c.jsrt_string_length(text), buf.len);
    for (0..len) |i| buf[i] = @truncate(c.jsrt_string_char(text, @intCast(i)));
    return buf[0..len];
}

fn throwFmt(cls: *const c.JSRTClass, comptime fmt: []const u8, args: anytype) void {
    @branchHint(.cold);
    var buf: [256]u8 = undefined;
    const msg = std.fmt.bufPrintZ(&buf, fmt, args) catch buf[0 .. buf.len - 1 :0];
    c.jsrt_throw_error(cls, msg.ptr);
}

fn throwLength(number: f64) void {
    var text: [64]u8 = undefined;
    throwFmt(&c.jsrt_class_range_error, "Invalid typed array length: {s}", .{numberText(number, &text)});
}

fn throwOffset(number: f64) void {
    var text: [64]u8 = undefined;
    throwFmt(&c.jsrt_class_range_error, "Start offset {s} is outside the bounds of the buffer", .{numberText(number, &text)});
}

/// V8's rendering of a receiver in `... called on incompatible receiver X`: primitives by their
/// ToString, an array as `[object Array]`, a view as `[object Uint8Array]`, any other object as
/// `#<Name>` (`#<Object>` for a nameless literal). A function would print its source text, which
/// compiled code no longer has, so it prints `function`.
fn receiverText(v: Value, buf: []u8) []const u8 {
    if (c.jsrt_is(v, c.JSRT_TAG_ARRAY)) return "[object Array]";
    if (c.jsrt_is(v, c.JSRT_TAG_CLOSURE)) return "function";
    if (classOf(v)) |cls| {
        if (cls == &jsrt_class_uint8array) return "[object Uint8Array]";
        const name = std.mem.span(cls.name);
        return std.fmt.bufPrint(buf, "#<{s}>", .{if (name.len == 0) "Object" else name}) catch "#<Object>";
    }
    const text = c.jsrt_to_string(v);
    var len: usize = 0;
    while (len < c.jsrt_string_length(text) and len < buf.len) : (len += 1) {
        buf[len] = @truncate(c.jsrt_string_char(text, @intCast(len)));
    }
    return buf[0..len];
}

fn throwReceiver(comptime method: []const u8, v: Value) void {
    var text: [128]u8 = undefined;
    throwFmt(&c.jsrt_class_type_error, "Method " ++ method ++ " called on incompatible receiver {s}", .{receiverText(v, &text)});
}

fn require(comptime T: type, v: Value, cls: *const c.JSRTClass, comptime method: []const u8) ?*T {
    return asClass(T, v, cls) orelse {
        throwReceiver(method, v);
        return null;
    };
}

fn requireView(v: Value, comptime method: []const u8) ?*View {
    return require(View, v, &jsrt_class_uint8array, method);
}

fn requireBuffer(v: Value, comptime method: []const u8) ?*Buffer {
    return require(Buffer, v, &jsrt_class_arraybuffer, method);
}

// ------------------------------------------------------------------------- allocation

/// A zeroed buffer of `len` bytes, or null with V8's RangeError pending when the allocator refuses.
fn newBuffer(len: usize) ?*Buffer {
    // The bytes first: their only reference until the header holds them is this raw local, which
    // the collector's conservative stack scan sees.
    const data = gc.allocAtomic(len) orelse {
        c.jsrt_throw_error(&c.jsrt_class_range_error, "Array buffer allocation failed");
        return null;
    };
    const b: *Buffer = @ptrCast(@alignCast(gc.alloc(@sizeOf(Buffer), "ArrayBuffer")));
    b.* = .{ .cls = &jsrt_class_arraybuffer, .data = @ptrCast(data), .byte_length = len };
    return b;
}

fn newView(buffer: *Buffer, byte_offset: usize, length: usize) Value {
    const v: *View = @ptrCast(@alignCast(gc.alloc(@sizeOf(View), "Uint8Array")));
    v.* = .{ .cls = &jsrt_class_uint8array, .buffer = buffer, .byte_offset = byte_offset, .length = length };
    return box(v);
}

/// A view over a fresh zeroed buffer of `len` bytes, or null with the exception pending.
fn freshView(len: usize) ?*View {
    const buffer = newBuffer(len) orelse return null;
    return @ptrCast(@alignCast(c.jsrt_ptr(newView(buffer, 0, len))));
}

/// A frame of `n` runtime-held values, published to the shadow stack so the collector traces them
/// -- a boxed value in a Zig local is invisible to the conservative scan (jsrt_gc.zig). The caller
/// pops it with `pop` on every exit path, which `defer` makes structural.
fn Frame(comptime n: usize) type {
    return struct {
        slots: [n]Value = [_]Value{undefined_value} ** n,
        frame: c.JSRTFrame = undefined,

        fn push(self: *@This()) void {
            self.frame = .{ .prev = c.jsrt_frame_top, .count = n, .slots = &self.slots, .env = null };
            c.jsrt_frame_top = &self.frame;
        }

        fn pop(self: *@This()) void {
            c.jsrt_frame_top = self.frame.prev;
        }
    };
}

// ------------------------------------------------------------------------- ArrayBuffer

export fn jsrt_arraybuffer_new(length: Value) Value {
    const n = toIndex(length) orelse return undefined_value;
    if (!n.ok) {
        c.jsrt_throw_error(&c.jsrt_class_range_error, "Invalid array buffer length");
        return undefined_value;
    }
    const buffer = newBuffer(n.size()) orelse return undefined_value;
    return box(buffer);
}

export fn jsrt_arraybuffer_byte_length(buffer: Value) Value {
    const b = requireBuffer(buffer, "get ArrayBuffer.prototype.byteLength") orelse return undefined_value;
    return c.jsrt_number(@floatFromInt(b.byte_length));
}

export fn jsrt_arraybuffer_slice(buffer: Value, start: Value, end: Value) Value {
    const b = requireBuffer(buffer, "ArrayBuffer.prototype.slice") orelse return undefined_value;
    const w = window(start, end, b.byte_length) orelse return undefined_value;
    const copy = newBuffer(w.len) orelse return undefined_value;
    @memcpy(copy.data[0..w.len], b.data[w.first..][0..w.len]);
    return box(copy);
}

// ------------------------------------------------------------------------- construction

/// The element at `i` of an array-like source, converted: ToNumber, then ToUint8 by the caller.
/// A string answers its code unit as a one-unit string (`new Uint8Array("12")` is a length, but
/// `set("12")` reads the characters), an array its element, anything else its property.
fn elementOf(source: Value, i: usize) Value {
    if (c.jsrt_is(source, c.JSRT_TAG_ARRAY)) {
        const a = c.jsrt_as_array(source);
        return if (i < a.*.length) c.jsrt_unhole(a.*.elements[i]) else undefined_value;
    }
    if (c.jsrt_is(source, c.JSRT_TAG_STRING)) {
        const unit = c.jsrt_string_char(source, @intCast(i));
        return c.jsrt_string_from_units(&unit, 1);
    }
    var key: [24]u8 = undefined;
    const text = std.fmt.bufPrintZ(&key, "{d}", .{i}) catch unreachable;
    return c.jsrt_get_prop(source, text.ptr, null);
}

/// The length of an array-like source; null when reading or converting it threw.
fn lengthOf(source: Value) ?usize {
    if (c.jsrt_is(source, c.JSRT_TAG_ARRAY)) return c.jsrt_as_array(source).*.length;
    if (c.jsrt_is(source, c.JSRT_TAG_STRING)) return c.jsrt_string_length(source);
    const len = c.jsrt_get_prop(source, "length", null);
    if (c.jsrt_pending()) return null;
    return toLength(len);
}

/// Copies `count` converted elements of `source` into `out` starting at element 0. Each element is
/// re-read after the previous conversion, which may have run user code; a source that shrank
/// reads `undefined`, i.e. 0. False when a conversion threw.
fn copyElements(out: *View, source: Value, count: usize) bool {
    for (0..count) |i| {
        const d = toNumber(elementOf(source, i));
        if (c.jsrt_pending()) return false;
        bytesOf(out)[i] = toUint8(d);
    }
    return true;
}

/// Whether `new Uint8Array(x)` takes `x` through its iterator rather than as an array-like
/// (§23.2.5.1 step 6.b): the built-in iterables and any object with an `__@iterator` method.
fn isIterable(source: Value) bool {
    if (c.jsrt_is_generator(source)) return true;
    if (classOf(source)) |cls| {
        if (cls == &c.jsrt_class_map or cls == &c.jsrt_class_set or cls == &c.jsrt_class_iterator) return true;
        const iterator = c.jsrt_get_prop(source, "__@iterator", null);
        return c.jsrt_is(iterator, c.JSRT_TAG_CLOSURE);
    }
    return false;
}

/// Drains `source` through its iterator into a fresh array, or answers `undefined` with the
/// exception pending: a non-iterable throws `X is not iterable` in `jsrt_get_iterator`, and a step
/// that throws stops the walk. Shared by `new Uint8Array(iterable)`, `Array.from` and spread.
fn drain(source: Value) Value {
    // slots: 0 the iterator, 1 the collected values, 2 the value in flight between the step that
    // produced it and the push that keeps it.
    var f: Frame(3) = .{};
    f.push();
    defer f.pop();
    f.slots[0] = c.jsrt_get_iterator(source);
    if (c.jsrt_pending()) return undefined_value;
    f.slots[1] = alloc.jsrt_array_new(0, null);
    while (c.jsrt_iterator_step(f.slots[0], &f.slots[2])) {
        _ = c.jsrt_array_push(f.slots[1], f.slots[2]);
    }
    if (c.jsrt_pending()) return undefined_value;
    return f.slots[1];
}

fn fromIterable(source: Value) Value {
    var f: Frame(1) = .{};
    f.push();
    defer f.pop();
    f.slots[0] = drain(source);
    if (c.jsrt_pending()) return undefined_value;
    const count: usize = c.jsrt_as_array(f.slots[0]).*.length;
    const out = freshView(count) orelse return undefined_value;
    if (!copyElements(out, f.slots[0], count)) return undefined_value;
    return box(out);
}

/// The operand of a spread, `[...x]` or `f(...x)` (§13.2.4.1, §13.3.8.1): an array answers itself,
/// because the caller's concat copies it and fills its holes, and anything else is drained. A
/// non-iterable throws `X is not iterable`; V8 names the operand's source text there, which a
/// value cannot (docs/VALUE.md §4.23).
export fn jsrt_spread_operand(source: Value) Value {
    if (c.jsrt_is(source, c.JSRT_TAG_ARRAY)) return source;
    return drain(source);
}

/// `Array.from(items)` with one argument (§23.1.2.1): nullish throws V8's TypeError, an iterable
/// (an array and a string included) is drained, any other object is read as an array-like
/// through `length`, and any other primitive is an array-like of length 0.
export fn jsrt_array_from(source: Value) Value {
    if (c.jsrt_is_nullish(source)) {
        throwFmt(&c.jsrt_class_type_error, "{s} is not iterable (cannot read property Symbol(Symbol.iterator))", .{if (c.jsrt_is(source, c.JSRT_TAG_NULL)) "object null" else "undefined"});
        return undefined_value;
    }
    if (c.jsrt_is(source, c.JSRT_TAG_ARRAY) or c.jsrt_is(source, c.JSRT_TAG_STRING) or isIterable(source)) {
        return drain(source);
    }
    if (c.jsrt_pending()) return undefined_value;
    var f: Frame(2) = .{};
    f.push();
    defer f.pop();
    f.slots[0] = alloc.jsrt_array_new(0, null);
    if (!c.jsrt_is(source, c.JSRT_TAG_OBJECT) and !c.jsrt_is(source, c.JSRT_TAG_CLOSURE)) return f.slots[0];
    const count = lengthOf(source) orelse return undefined_value;
    for (0..count) |i| {
        f.slots[1] = elementOf(source, i);
        if (c.jsrt_pending()) return undefined_value;
        _ = c.jsrt_array_push(f.slots[0], f.slots[1]);
    }
    return f.slots[0];
}

/// `new Map(iterable)`, `new Set(iterable)` and their weak twins with one argument (§24.1.1.1,
/// §24.2.2.1, §24.3.1.1, §24.4.1.1; docs/VALUE.md §4.25). Nullish builds an empty collection; any
/// other value is iterated as a spread is, and each value is added in order -- for a Map, each
/// value must be an object whose `0` and `1` are the key and the value, or the walk throws V8's
/// TypeError and closes the iterator. The weak twins' key check is the collection's own `set`/`add`.
fn collectionFrom(target: Value, source: Value, entries: bool) Value {
    if (c.jsrt_is_nullish(source)) return target;
    // slots: 0 the collection, 1 the iterator, 2 the value in flight, 3 an entry's key.
    var f: Frame(4) = .{};
    f.push();
    defer f.pop();
    f.slots[0] = target;
    f.slots[1] = c.jsrt_get_iterator(source);
    if (c.jsrt_pending()) return undefined_value;
    while (c.jsrt_iterator_step(f.slots[1], &f.slots[2])) {
        if (!entries) {
            _ = c.jsrt_set_add(f.slots[0], f.slots[2]);
        } else if (!c.jsrt_is_object(f.slots[2])) {
            throwNotEntry(f.slots[2]);
        } else {
            f.slots[3] = c.jsrt_array_get(f.slots[2], c.jsrt_number(0));
            if (!c.jsrt_pending()) {
                const value = c.jsrt_array_get(f.slots[2], c.jsrt_number(1));
                if (!c.jsrt_pending()) _ = c.jsrt_map_set(f.slots[0], f.slots[3], value);
            }
        }
        if (c.jsrt_pending()) {
            // IteratorClose on an abrupt completion: a generator's `finally` runs. The close's own
            // throw, if any, loses to the one already pending, as §7.4.11 orders it.
            f.slots[2] = c.jsrt_take_exception();
            c.jsrt_iterator_close(f.slots[1]);
            if (c.jsrt_pending()) _ = c.jsrt_take_exception();
            c.jsrt_throw(f.slots[2]);
            return undefined_value;
        }
    }
    if (c.jsrt_pending()) return undefined_value;
    return f.slots[0];
}

/// V8's `Iterator value X is not an entry object`, with X the value's string form.
fn throwNotEntry(value: Value) void {
    @branchHint(.cold);
    const text = c.jsrt_to_string(value);
    if (c.jsrt_pending()) return;
    var name: [96]u8 = undefined;
    const len = @min(c.jsrt_string_length(text), name.len);
    for (0..len) |i| name[i] = @truncate(c.jsrt_string_char(text, @intCast(i)));
    throwFmt(&c.jsrt_class_type_error, "Iterator value {s} is not an entry object", .{name[0..len]});
}

export fn jsrt_map_from(source: Value) Value {
    return collectionFrom(c.jsrt_map_new(), source, true);
}

export fn jsrt_set_from(source: Value) Value {
    return collectionFrom(c.jsrt_set_new(), source, false);
}

export fn jsrt_weakmap_from(source: Value) Value {
    return collectionFrom(c.jsrt_weak_collection_new(true), source, true);
}

export fn jsrt_weakset_from(source: Value) Value {
    return collectionFrom(c.jsrt_weak_collection_new(false), source, false);
}

fn overBuffer(buffer: *Buffer, offset: Value, length: Value) Value {
    const off = toIndex(offset) orelse return undefined_value;
    if (!off.ok) {
        throwOffset(off.integer);
        return undefined_value;
    }
    const start = off.size();
    if (length == undefined_value) {
        if (start > buffer.byte_length) {
            throwOffset(off.integer);
            return undefined_value;
        }
        return newView(buffer, start, buffer.byte_length - start);
    }
    const len = toIndex(length) orelse return undefined_value;
    if (!len.ok) {
        throwLength(len.number);
        return undefined_value;
    }
    if (off.integer + len.integer > @as(f64, @floatFromInt(buffer.byte_length))) {
        throwLength(len.integer);
        return undefined_value;
    }
    return newView(buffer, start, len.size());
}

export fn jsrt_uint8array_new(source: Value, offset: Value, length: Value) Value {
    const is_object = c.jsrt_is(source, c.JSRT_TAG_OBJECT) or c.jsrt_is(source, c.JSRT_TAG_ARRAY) or
        c.jsrt_is(source, c.JSRT_TAG_CLOSURE);
    if (!is_object) {
        const n = toIndex(source) orelse return undefined_value;
        if (!n.ok) {
            throwLength(n.number);
            return undefined_value;
        }
        const out = freshView(n.size()) orelse return undefined_value;
        return box(out);
    }
    if (asBuffer(source)) |buffer| return overBuffer(buffer, offset, length);
    if (asView(source)) |src| {
        const out = freshView(src.length) orelse return undefined_value;
        @memcpy(bytesOf(out), bytesOf(src));
        return box(out);
    }
    if (!c.jsrt_is(source, c.JSRT_TAG_ARRAY) and isIterable(source)) return fromIterable(source);
    if (c.jsrt_pending()) return undefined_value;
    const count = lengthOf(source) orelse return undefined_value;
    const out = freshView(count) orelse return undefined_value;
    if (!copyElements(out, source, count)) return undefined_value;
    return box(out);
}

// ------------------------------------------------------------------------- views

/// A numeric data property of a view; `field` names the View member that answers it (one byte
/// per element, so `byteLength` and `length` read the same field).
fn viewNumber(array: Value, comptime name: []const u8, comptime field: []const u8) Value {
    const v = requireView(array, "get TypedArray.prototype." ++ name) orelse return undefined_value;
    return c.jsrt_number(@floatFromInt(@field(v, field)));
}

export fn jsrt_uint8array_length(array: Value) Value {
    return viewNumber(array, "length", "length");
}

export fn jsrt_uint8array_byte_length(array: Value) Value {
    return viewNumber(array, "byteLength", "length");
}

export fn jsrt_uint8array_byte_offset(array: Value) Value {
    return viewNumber(array, "byteOffset", "byte_offset");
}

export fn jsrt_uint8array_buffer(array: Value) Value {
    const v = requireView(array, "get TypedArray.prototype.buffer") orelse return undefined_value;
    return box(v.buffer);
}

/// The numeric index a property key names, per CanonicalNumericIndexString (§7.1.21): a number
/// is its own index (-0 included: its key is "0"); a string is one only when it round-trips
/// through ToNumber/ToString, or is "-0", which is numeric but never a valid index. `null` means
/// the key is an ordinary property name.
fn numericKey(index: Value) ?f64 {
    if (c.jsrt_is_number(index)) return c.jsrt_number_value(index);
    if (!c.jsrt_is(index, c.JSRT_TAG_STRING)) return null;
    const len = c.jsrt_string_length(index);
    if (len == 2 and c.jsrt_string_char(index, 0) == '-' and c.jsrt_string_char(index, 1) == '0') return -1;
    const d = c.jsrt_to_number(index);
    const back = c.jsrt_to_string(c.jsrt_number(d));
    if (c.jsrt_string_length(back) != len) return null;
    for (0..len) |i| {
        if (c.jsrt_string_char(back, @intCast(i)) != c.jsrt_string_char(index, @intCast(i))) return null;
    }
    return d;
}

/// The element a numeric key addresses, or null when it is not an integer in range.
fn slot(view: *const View, d: f64) ?usize {
    if (!(d >= 0) or d != @trunc(d) or d >= @as(f64, @floatFromInt(view.length))) return null;
    return @intFromFloat(d);
}

export fn jsrt_uint8array_get(array: Value, index: Value) Value {
    const view = asView(array) orelse return c.jsrt_dyn_index_get(array, index, null);
    const d = numericKey(index) orelse {
        const key = c.jsrt_shape_key(c.jsrt_to_string(index));
        defer std.c.free(@constCast(key));
        return c.jsrt_get_prop(array, key, null);
    };
    const i = slot(view, d) orelse return undefined_value;
    return c.jsrt_number(@floatFromInt(bytesOf(view)[i]));
}

export fn jsrt_uint8array_put(array: Value, index: Value, value: Value) void {
    const view = asView(array) orelse return c.jsrt_dyn_index_set(array, index, value, null);
    const d = numericKey(index) orelse {
        const key = c.jsrt_shape_key(c.jsrt_to_string(index));
        defer std.c.free(@constCast(key));
        return c.jsrt_set_prop(array, key, value, null);
    };
    // TypedArraySetElement (§10.4.5.16): the value converts BEFORE the index is checked, so a
    // throwing conversion throws even for an index the write would drop.
    const byte = toUint8(toNumber(value));
    if (c.jsrt_pending()) return;
    const i = slot(view, d) orelse return;
    bytesOf(view)[i] = byte;
}

export fn jsrt_uint8array_subarray(array: Value, begin: Value, end: Value) Value {
    const v = requireView(array, "%TypedArray%.prototype.subarray") orelse return undefined_value;
    const w = window(begin, end, v.length) orelse return undefined_value;
    return newView(v.buffer, v.byte_offset + w.first, w.len);
}

export fn jsrt_uint8array_slice(array: Value, start: Value, end: Value) Value {
    const v = requireView(array, "%TypedArray%.prototype.slice") orelse return undefined_value;
    const w = window(start, end, v.length) orelse return undefined_value;
    const out = freshView(w.len) orelse return undefined_value;
    @memcpy(bytesOf(out), bytesOf(v)[w.first..][0..w.len]);
    return box(out);
}

export fn jsrt_uint8array_set(array: Value, source: Value, offset: Value) Value {
    const target = asView(array) orelse {
        c.jsrt_throw_error(&c.jsrt_class_type_error, "this is not a typed array.");
        return undefined_value;
    };
    const at = if (offset == undefined_value) 0 else toInteger(toNumber(offset));
    if (c.jsrt_pending()) return undefined_value;
    if (at < 0) {
        c.jsrt_throw_error(&c.jsrt_class_range_error, "offset is out of bounds");
        return undefined_value;
    }
    if (c.jsrt_is_nullish(source)) {
        throwFmt(&c.jsrt_class_type_error, "Cannot convert undefined or null to object", .{});
        return undefined_value;
    }
    const count = if (asView(source)) |src| src.length else if (c.jsrt_is_number(source) or c.jsrt_is(source, c.JSRT_TAG_BOOL))
        0
    else
        lengthOf(source) orelse return undefined_value;
    if (@as(f64, @floatFromInt(count)) + at > @as(f64, @floatFromInt(target.length))) {
        c.jsrt_throw_error(&c.jsrt_class_range_error, "offset is out of bounds");
        return undefined_value;
    }
    const start: usize = @intFromFloat(at);
    if (asView(source)) |src| {
        // Two views of one buffer may overlap; @memmove copies as if through a temporary, which
        // is what §23.2.3.26.2 step 23's clone of the source buffer guarantees.
        @memmove(bytesOf(target)[start..][0..count], bytesOf(src));
        return undefined_value;
    }
    for (0..count) |i| {
        const d = toNumber(elementOf(source, i));
        if (c.jsrt_pending()) return undefined_value;
        bytesOf(target)[start + i] = toUint8(d);
    }
    return undefined_value;
}

/// `String(bytes)`: the elements joined by ",", which is what `%TypedArray%.prototype.toString`
/// (the inherited `Array.prototype.join`) answers.
export fn jsrt_uint8array_text(array: Value) Value {
    const view = asView(array) orelse return c.jsrt_to_string(array);
    const bytes = bytesOf(view);
    const out: [*]u8 = @ptrCast(mem.mallocOrPanic(bytes.len * 4, "Uint8Array join") orelse return c.jsrt_string_from_utf8("", 0));
    defer std.c.free(out);
    var n: usize = 0;
    for (bytes, 0..) |b, i| {
        if (i > 0) {
            out[n] = ',';
            n += 1;
        }
        n += (std.fmt.bufPrint(out[n..][0..3], "{d}", .{b}) catch unreachable).len;
    }
    return c.jsrt_string_from_utf8(out, n);
}

// ------------------------------------------------------------------------- the dynamic tier

const Method = enum(u8) { subarray, slice, set, buffer_slice };

fn methodCall(argc: u32, argv: [*c]const Value, env: ?*c.JSRTEnv) callconv(.c) Value {
    const slots = env.?.slots();
    const receiver = slots[0];
    const a0 = if (argc > 0) argv[0] else undefined_value;
    const a1 = if (argc > 1) argv[1] else undefined_value;
    const op: Method = @enumFromInt(@as(u8, @intFromFloat(c.jsrt_number_value(slots[1]))));
    return switch (op) {
        .subarray => jsrt_uint8array_subarray(receiver, a0, a1),
        .slice => jsrt_uint8array_slice(receiver, a0, a1),
        .set => jsrt_uint8array_set(receiver, a0, a1),
        .buffer_slice => jsrt_arraybuffer_slice(receiver, a0, a1),
    };
}

/// A method read as a value: a closure over the receiver, the `jsrt_array_method` contract.
fn boundMethod(receiver: Value, op: Method, name: [*:0]const u8, arity: u32) Value {
    const env = alloc.jsrt_env_new(null, 2);
    env.slots()[0] = receiver;
    env.slots()[1] = c.jsrt_number(@floatFromInt(@intFromEnum(op)));
    return alloc.jsrt_closure_new(methodCall, arity, name, env, false);
}

fn is(key: [*c]const u8, comptime name: []const u8) bool {
    return std.mem.eql(u8, std.mem.span(key), name);
}

export fn jsrt_typed_get_prop(obj: Value, key: [*c]const u8, out: *Value) bool {
    if (asView(obj)) |view| {
        var index: u32 = 0;
        if (c.jsrt_key_is_array_index(key, &index)) {
            out.* = if (index < view.length) c.jsrt_number(@floatFromInt(bytesOf(view)[index])) else undefined_value;
            return true;
        }
        if (is(key, "length") or is(key, "byteLength")) {
            out.* = c.jsrt_number(@floatFromInt(view.length));
        } else if (is(key, "byteOffset")) {
            out.* = c.jsrt_number(@floatFromInt(view.byte_offset));
        } else if (is(key, "buffer")) {
            out.* = box(view.buffer);
        } else if (is(key, "subarray")) {
            out.* = boundMethod(obj, .subarray, "subarray", 2);
        } else if (is(key, "slice")) {
            out.* = boundMethod(obj, .slice, "slice", 2);
        } else if (is(key, "set")) {
            out.* = boundMethod(obj, .set, "set", 1);
        } else {
            return false;
        }
        return true;
    }
    if (asBuffer(obj)) |buffer| {
        if (is(key, "byteLength")) {
            out.* = c.jsrt_number(@floatFromInt(buffer.byte_length));
        } else if (is(key, "slice")) {
            out.* = boundMethod(obj, .buffer_slice, "slice", 2);
        } else {
            return false;
        }
        return true;
    }
    return false;
}
