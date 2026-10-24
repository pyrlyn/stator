//! The shape table: hidden classes for dynamic objects (docs/VALUE.md §4.10; the layout and its
//! invariants are the header block over JSRTShape in jsrt_value.h). jsrt_shape.c keeps the property
//! semantics built on it -- inline caches, accessors, the TypeErrors -- and reaches the table only
//! through the functions below (src/jsrt_mem.h).
//!
//! A transition reuses an existing child before allocating, because shape sharing is the entire
//! point: two objects that gained the same keys in the same order must land on the same shape, or
//! every inline cache downstream of them degrades to the slow path. Shapes hold no values and are
//! immortal metadata (the table only grows, by design), so they are plain malloc; slot storage holds
//! jsrt_values, so it is a COLLECTED allocation the collector scans.

const std = @import("std");
const mem = @import("jsrt_mem.zig");
const gc = @import("jsrt_gc.zig");
const c = mem.c;

const Shape = c.JSRTShape;
const Link = *const Shape;

/// The one shape with no key: every dynamic object starts here, and an array's first named property
/// transitions from it. Static, so "has no properties" needs no allocation and compares by address.
pub export var jsrt_shape_root: Shape = std.mem.zeroes(Shape);

fn slotCount(shape: *const Shape) u32 {
    return if (shape.key == null) 0 else shape.offset + 1;
}

/// Pointer compare first -- generated C passes string literals, and the transition that created a
/// shape stored that same literal -- with a byte compare as the backstop for a key spelled at two
/// sites. Interned keys from `jsrt_shape_intern` compare equal by pointer.
fn sameKey(a: [*c]const u8, b: [*c]const u8) bool {
    return a == b or std.mem.orderZ(u8, @ptrCast(a), @ptrCast(b)) == .eq;
}

/// Immortal intern table for UTF-8 shape keys. `jsrt_shape_key` mallocs a conversion buffer and
/// hands it here; a second intern of the same bytes returns the first pointer and frees the
/// duplicate. Keys outlive the program the way shapes do, and are plain malloc.
const Intern = struct {
    key: [*:0]u8,
    hash: u64,
    next: ?*Intern,
};

var intern_buckets: []?*Intern = &.{};
var intern_count: usize = 0;
const concurrent = @import("jsrt_concurrent.zig");
var metadata_lock: std.c.pthread_mutex_t = .{};

/// How many distinct keys the table holds. Compare-only lookups must not move it.
export fn jsrt_shape_intern_count() usize {
    concurrent.lock(&metadata_lock);
    defer concurrent.unlock(&metadata_lock);
    return intern_count;
}

fn internHash(bytes: []const u8) u64 {
    var h: u64 = 14695981039346656037;
    for (bytes) |b| {
        h ^= b;
        h *%= 1099511628211;
    }
    return h;
}

fn internBuckets(n: usize) []?*Intern {
    const bytes = n * @sizeOf(?*Intern);
    const raw = std.c.malloc(bytes) orelse c.jsrt_panic("out of memory: shape intern");
    const ptr: [*]?*Intern = @ptrCast(@alignCast(raw));
    const slice = ptr[0..n];
    @memset(slice, null);
    return slice;
}

fn internRehash(next_len: usize) void {
    const fresh = internBuckets(next_len);
    for (intern_buckets) |head| {
        var node = head;
        while (node) |n| {
            const nxt = n.next;
            const slot = &fresh[n.hash % next_len];
            n.next = slot.*;
            slot.* = n;
            node = nxt;
        }
    }
    if (intern_buckets.len != 0) std.c.free(@ptrCast(intern_buckets.ptr));
    intern_buckets = fresh;
}

export fn jsrt_shape_intern(key: [*:0]u8) [*:0]const u8 {
    concurrent.lock(&metadata_lock);
    defer concurrent.unlock(&metadata_lock);
    const bytes = std.mem.span(key);
    const h = internHash(bytes);
    if (intern_buckets.len == 0) internRehash(8);
    const slot = &intern_buckets[h % intern_buckets.len];
    var node = slot.*;
    while (node) |n| {
        if (n.hash == h and std.mem.eql(u8, std.mem.span(n.key), bytes)) {
            std.c.free(key);
            return n.key;
        }
        node = n.next;
    }
    const raw = std.c.malloc(@sizeOf(Intern)) orelse c.jsrt_panic("out of memory: shape intern");
    const fresh: *Intern = @ptrCast(@alignCast(raw));
    fresh.* = .{ .key = key, .hash = h, .next = slot.* };
    slot.* = fresh;
    intern_count += 1;
    if (intern_count > intern_buckets.len) internRehash(intern_buckets.len * 2);
    return key;
}

/// Enumeration order (§10.1.11.1 OrdinaryOwnPropertyKeys): array-index keys first, ascending, then
/// every other key in insertion order, which is offset order. Offsets are unique, so this is a
/// total order and any sort of it is deterministic. The index test is the one C spelling
/// (`jsrt_key_is_array_index`), shared with fixed-shape enumeration, not a second copy.
fn before(_: void, a: Link, b: Link) bool {
    var ai: u32 = 0;
    var bi: u32 = 0;
    const a_index = c.jsrt_key_is_array_index(a.key, &ai);
    const b_index = c.jsrt_key_is_array_index(b.key, &bi);
    if (a_index != b_index) return a_index;
    if (a_index and ai != bi) return ai < bi;
    return a.offset < b.offset;
}

/// NULL is an array that never gained a property -- the same "no properties" the root shape means
/// for a dynamic object, spelled without an allocation.
export fn jsrt_shape_property_count(shape: ?*const Shape) u32 {
    return if (shape) |s| slotCount(s) else 0;
}

/// The chain flattened into slot order: `links[i]` is the node whose value lives in slot `i`. That
/// IS insertion order, which both users need before anything else -- enumeration sorts it, and a
/// delete replays it. Malloc'd; the caller frees it.
fn chainLinks(shape: ?*const Shape, count: u32) ?[*]Link {
    const bytes = @as(usize, count) * @sizeOf(Link);
    const links: ?[*]Link = @ptrCast(@alignCast(mem.mallocOrPanic(bytes, "out of memory: dynamic object keys")));
    var s = shape;
    while (s) |node| : (s = node.parent) {
        if (node.key == null) break;
        links.?[node.offset] = node;
    }
    return links;
}

export fn jsrt_shape_property_order(shape: ?*const Shape, count: u32) ?[*]Link {
    const links = chainLinks(shape, count);
    if (links) |l| std.sort.insertion(Link, l[0..count], {}, before);
    return links;
}

/// The chain walk get, has, set and delete share: an object's live keys are exactly the keys on the
/// path from its shape back to the root.
export fn jsrt_shape_find(shape: *const Shape, key: [*c]const u8) ?*const Shape {
    var s = shape;
    while (s.key != null) : (s = s.parent) {
        if (sameKey(s.key, key)) return s;
    }
    return null;
}

/// Reuse before allocation is what keeps two same-history objects on ONE shape -- and it is why a
/// delete can replay a chain minus one key and land where an object built without that key would.
export fn jsrt_shape_transition(from: *Shape, key: [*c]const u8) *Shape {
    concurrent.lock(&metadata_lock);
    defer concurrent.unlock(&metadata_lock);
    var child: ?*Shape = from.transitions;
    while (child) |s| : (child = s.sibling) {
        if (sameKey(s.key, key)) return s;
    }
    const raw = std.c.malloc(@sizeOf(Shape)) orelse c.jsrt_panic("out of memory: shape");
    const next: *Shape = @ptrCast(@alignCast(raw));
    next.* = .{
        .parent = from,
        .key = key,
        .offset = slotCount(from),
        .transitions = null,
        .sibling = from.transitions,
    };
    from.transitions = next;
    return next;
}

/// Doubling from 4, so repeated additions stay amortized O(1). The old slots are copied, not
/// reallocated in place: under Boehm the old block is simply dropped for the collector.
export fn jsrt_shape_reserve(slots: *[*c]c.jsrt_value, capacity: *u32, offset: u32) void {
    if (offset < capacity.*) return;
    var grown: u32 = if (capacity.* == 0) 4 else capacity.* * 2;
    while (grown <= offset) grown *= 2;
    const bytes = @as(usize, grown) * @sizeOf(c.jsrt_value);
    const fresh: [*]c.jsrt_value = @ptrCast(@alignCast(gc.alloc(bytes, "dynamic object slots")));
    if (capacity.* > 0) @memcpy(fresh[0..capacity.*], slots.*[0..capacity.*]);
    if (!gc.boehm) std.c.free(@ptrCast(slots.*));
    slots.* = fresh;
    capacity.* = grown;
}

/// The shape rebuild. A shape node is shared metadata -- other objects sit on the same chain -- so
/// removing a key means replaying the chain from the root without it and compacting the slots to
/// match. `next` never runs ahead of `i`, so the compaction reads every slot before it is written.
/// Deliberately not IC-aware: an IC is trusted by shape-pointer compare, and the object now holds
/// a different pointer, so every cache filled against the old shape simply misses.
export fn jsrt_shape_remove(shape: **Shape, slots: [*c]c.jsrt_value, hit: *const Shape) void {
    const count = slotCount(shape.*);
    const links = chainLinks(shape.*, count);
    defer std.c.free(@ptrCast(links));
    var replay: *Shape = &jsrt_shape_root;
    var next: u32 = 0;
    for (0..count) |i| {
        const link = links.?[i];
        if (link == hit) continue;
        replay = jsrt_shape_transition(replay, link.key);
        slots[next] = slots[i];
        next += 1;
    }
    shape.* = replay;
}

// Fixed-layout spread descriptors share the same immutable metadata lifetime as shapes.
export fn jsrt_shape_metadata_lock() void {
    concurrent.lock(&metadata_lock);
}
export fn jsrt_shape_metadata_unlock() void {
    concurrent.unlock(&metadata_lock);
}
