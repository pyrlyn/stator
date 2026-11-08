//! The collector: pyrlyn/gc driven as coalesced deferred reference counting (docs/VALUE.md §4,
//! plan-notes 407).
//!
//! Every collected block sits behind a hidden 16-byte prefix in the layout pyrlyn/gc's kxgc.h
//! defines: a header word (count in bits 0-31, color 32-33, buffered bit 34) and a vtable pointer.
//! The vtable is the object's `JSRTGcKind`, whose first member is the kxgc vtable. Runtime pointers
//! -- the payload of a boxed value, a `JSRTEnv *` -- address the object after the prefix, so no
//! runtime layout changed.
//!
//! Counts cover heap-to-heap references only, and they are brought up to date only while a
//! collection runs (Levanoni and Petrank's coalescing). A runtime function that changes the
//! references inside an existing object first calls `jsrt_gc_write(obj)`. The first call after a
//! collection marks the object dirty and logs the references it held then. A collection then adds
//! one count for every reference a dirty object holds now and takes one away for every reference
//! its log holds. Stores therefore need no per-store barrier.
//!
//! A new object is young until the next collection: it needs no `jsrt_gc_write` and is on no list
//! but the young one. A collection traces only the young objects that survive -- those a root or a
//! reconciled object names, and what they name in turn -- and adds their references to the counts.
//! Every other young object is dead and is freed without being traced, so a short-lived object
//! costs its allocation and nothing else, and a young garbage cycle needs no trial deletion.
//!
//! Frame slots, globals, C and Zig locals and static storage are not counted: they are the roots,
//! read with the world stopped. Each thread's `JSRT_FRAME` chain is read precisely (the globals
//! frame is on it), its pending-exception cell and handoff slot too; its native stack, its saved
//! callee-saved registers and the writable segments of the image the runtime is linked into are
//! read conservatively, every word masked with the 48-bit payload mask. That is what lets runtime C
//! keep raw pointers in locals across allocations (plan-notes 163) and values in static caches.
//!
//! An object a root names is pinned (+1) for the collection, and if it is dirty it stays dirty
//! through the next one: a runtime function may hold it across the allocation that collected and
//! store into it afterwards without logging again. Objects whose kind is `always_dirty` (closure
//! environments, whose slots generated code writes directly) are reconciled at every collection.
//!
//! An object whose count is 0 waits in the zero-count table (ZCT); a collection frees the entries
//! no root names, releasing their references, which may free more. Cycles go to pyrlyn/gc's trial
//! deletion (perceus, Bacon-Rajan), run with the roots pinned. `rt_rel_draining` stays set outside
//! that window, so marking a candidate never starts trial deletion on its own.
//!
//! Owned storage -- an array's elements, a Map's entries -- is a buffer block: indexed like an
//! object, never counted, freed by its owner's finalizer. A root word inside a buffer roots the
//! buffer's owner. A buffer the owner replaced is retired and freed by the first collection that
//! finds no root word inside it.

const std = @import("std");
const builtin = @import("builtin");
const mem = @import("jsrt_mem.zig");
const stack = @import("jsrt_stack.zig");
const kx = @import("kxgc");
const host = @import("host");
const collector = @import("collector");
const c = mem.c;

const Value = c.jsrt_value;
pub const Kind = c.JSRTGcKind;

// ---------------------------------------------------------------- the hidden prefix

const prefix: usize = 16;

/// Bits above kxgc's 35 belong to the runtime: the block size, then flags.
const size_shift: u6 = 35;
const size_bits: u6 = 21;
const size_field: u64 = (@as(u64, 1) << size_bits) - 1;
/// Allocated since the last collection, and not yet found alive by one.
const young_bit: u64 = 1 << 56;
/// The size counts 4 KiB pages instead of 8-byte granules (a block past 16 MiB).
const page_bit: u64 = 1 << 57;
const buffer_bit: u64 = 1 << 58;
/// Released its references in a ZCT sweep while trial deletion still had it buffered.
const swept_bit: u64 = 1 << 59;
const dirty_bit: u64 = 1 << 60;
const zct_bit: u64 = 1 << 61;
const root_bit: u64 = 1 << 62;
/// Finalized; its memory is released when the list that still names it lets go.
const dead_bit: u64 = 1 << 63;

const Header = extern struct {
    word: u64,
    /// The kind of an object; for a buffer, its owner's runtime address (0: none).
    meta: usize,
};

inline fn blockOf(obj: usize) *Header {
    return @ptrFromInt(obj - prefix);
}

inline fn objAddr(block: *const Header) usize {
    return @intFromPtr(block) + prefix;
}

inline fn objOf(block: *const Header) *anyopaque {
    return @ptrFromInt(objAddr(block));
}

inline fn kindOf(block: *const Header) *const Kind {
    return @ptrFromInt(block.meta);
}

fn blockBytes(block: *const Header) usize {
    const units: usize = @intCast((block.word >> size_shift) & size_field);
    return if (block.word & page_bit != 0) units * 4096 else units * 8;
}

fn sizeWord(total: usize) u64 {
    if (total / 8 <= size_field) return @as(u64, total / 8) << size_shift;
    return (@as(u64, total / 4096) << size_shift) | page_bit;
}

/// Bytes a request occupies with its prefix, rounded so the size field holds it exactly.
fn blockTotal(bytes: usize, what: [*:0]const u8) usize {
    const total = prefix + std.mem.alignForward(usize, if (bytes == 0) 1 else bytes, 8);
    if (total / 8 <= size_field) return total;
    const paged = std.mem.alignForward(usize, total, 4096);
    if (paged / 4096 > size_field) oom(what);
    return paged;
}

inline fn count(block: *const Header) u64 {
    return block.word & kx.CNT_MASK;
}

inline fn isCyclic(block: *const Header) bool {
    return kindOf(block).vtab.cyclic != null;
}

// ---------------------------------------------------------------- small growable lists

fn List(comptime T: type) type {
    return struct {
        items: [*]T = undefined,
        len: usize = 0,
        cap: usize = 0,

        const Self = @This();

        fn push(self: *Self, item: T) void {
            if (self.len == self.cap) {
                const cap = if (self.cap == 0) 256 else self.cap * 2;
                const raw = std.c.realloc(if (self.cap == 0) null else @ptrCast(self.items), cap * @sizeOf(T)) orelse
                    c.jsrt_panic("out of memory: collector list");
                self.items = @ptrCast(@alignCast(raw));
                self.cap = cap;
            }
            self.items[self.len] = item;
            self.len += 1;
        }

        fn pop(self: *Self) ?T {
            if (self.len == 0) return null;
            self.len -= 1;
            return self.items[self.len];
        }

        fn slice(self: *Self) []T {
            return self.items[0..self.len];
        }

        fn deinit(self: *Self) void {
            if (self.cap != 0) std.c.free(@ptrCast(self.items));
            self.* = .{};
        }
    };
}

// ---------------------------------------------------------------- the block index

/// Which 8-byte granules start a live block, per 64 KiB of address space: how a conservative root
/// word is resolved to the block it points into, and how a pointer is told from a collected one.
const Chunk = struct { bits: [128]u64 = @splat(0) };
const chunk_shift: u6 = 16;
const chunk_bytes: usize = 1 << chunk_shift;

const ChunkTable = struct {
    keys: [*]usize = undefined,
    chunks: [*]?*Chunk = undefined,
    cap: usize = 0,
    used: usize = 0,

    fn slot(self: *const ChunkTable, key: usize) usize {
        var i = (key *% 0x9E3779B97F4A7C15) & (self.cap - 1);
        while (self.chunks[i] != null and self.keys[i] != key) i = (i + 1) & (self.cap - 1);
        return i;
    }

    fn find(self: *const ChunkTable, key: usize) ?*Chunk {
        if (self.cap == 0) return null;
        return self.chunks[self.slot(key)];
    }

    fn grow(self: *ChunkTable) void {
        const old_keys = self.keys;
        const old_chunks = self.chunks;
        const old_cap = self.cap;
        self.cap = if (old_cap == 0) 64 else old_cap * 2;
        self.keys = @ptrCast(@alignCast(std.c.malloc(self.cap * @sizeOf(usize)) orelse c.jsrt_panic("out of memory: collector index")));
        self.chunks = @ptrCast(@alignCast(std.c.calloc(self.cap, @sizeOf(?*Chunk)) orelse c.jsrt_panic("out of memory: collector index")));
        for (0..old_cap) |i| {
            if (old_chunks[i]) |chunk| {
                const s = self.slot(old_keys[i]);
                self.keys[s] = old_keys[i];
                self.chunks[s] = chunk;
            }
        }
        if (old_cap != 0) {
            std.c.free(@ptrCast(old_keys));
            std.c.free(@ptrCast(old_chunks));
        }
    }

    fn get(self: *ChunkTable, key: usize) *Chunk {
        if (self.find(key)) |chunk| return chunk;
        if ((self.used + 1) * 2 > self.cap) self.grow();
        const chunk: *Chunk = @ptrCast(@alignCast(std.c.malloc(@sizeOf(Chunk)) orelse c.jsrt_panic("out of memory: collector index")));
        chunk.* = .{};
        const s = self.slot(key);
        self.keys[s] = key;
        self.chunks[s] = chunk;
        self.used += 1;
        return chunk;
    }
};

var index: ChunkTable = .{};
/// Blocks larger than a chunk, sorted by address: a word inside one may be chunks past its start.
var large: List(usize) = .{};
var heap_lo: usize = std.math.maxInt(usize);
var heap_hi: usize = 0;

const Granule = struct { word: usize, bit: u6 };

inline fn granule(addr: usize) Granule {
    const g = (addr & (chunk_bytes - 1)) >> 3;
    return .{ .word = g >> 6, .bit = @intCast(g & 63) };
}

fn largeLowerBound(addr: usize) usize {
    var lo: usize = 0;
    var hi: usize = large.len;
    while (lo < hi) {
        const mid = (lo + hi) / 2;
        if (large.items[mid] < addr) lo = mid + 1 else hi = mid;
    }
    return lo;
}

fn indexInsert(block: *Header, total: usize) void {
    const addr = @intFromPtr(block);
    const g = granule(addr);
    index.get(addr >> chunk_shift).bits[g.word] |= @as(u64, 1) << g.bit;
    if (addr < heap_lo) heap_lo = addr;
    if (addr + total > heap_hi) heap_hi = addr + total;
    if (total > chunk_bytes) {
        const at = largeLowerBound(addr);
        large.push(0);
        std.mem.copyBackwards(usize, large.items[at + 1 .. large.len], large.items[at .. large.len - 1]);
        large.items[at] = addr;
    }
}

fn indexRemove(block: *Header, total: usize) void {
    const addr = @intFromPtr(block);
    const g = granule(addr);
    if (index.find(addr >> chunk_shift)) |chunk| chunk.bits[g.word] &= ~(@as(u64, 1) << g.bit);
    if (total > chunk_bytes) {
        const at = largeLowerBound(addr);
        if (at < large.len and large.items[at] == addr) {
            std.mem.copyForwards(usize, large.items[at .. large.len - 1], large.items[at + 1 .. large.len]);
            large.len -= 1;
        }
    }
}

threadlocal var cached_key: usize = std.math.maxInt(usize);
threadlocal var cached_chunk: ?*Chunk = null;

/// Whether a block starts exactly at `addr`. A chunk, once made, is never freed, so the cache
/// stays valid while the table grows around it.
fn isBlockStart(addr: usize) bool {
    if (addr < heap_lo or addr >= heap_hi or addr & 7 != 0) return false;
    const key = addr >> chunk_shift;
    const chunk = if (key == cached_key) cached_chunk else blk: {
        const found = index.find(key);
        // A chunk found absent may be made later; only a found one is cached.
        if (found != null) {
            cached_key = key;
            cached_chunk = found;
        }
        break :blk found;
    };
    const g = granule(addr);
    return (chunk orelse return false).bits[g.word] & (@as(u64, 1) << g.bit) != 0;
}

/// The latest block start at or below `addr`, searching back at most `chunks` chunks.
fn startBelow(addr: usize, chunks: usize) ?usize {
    var key = addr >> chunk_shift;
    var limit = granule(addr);
    var left = chunks;
    while (true) {
        if (index.find(key)) |chunk| {
            var w = limit.word;
            var mask: u64 = if (limit.bit == 63) ~@as(u64, 0) else (@as(u64, 2) << limit.bit) - 1;
            while (true) {
                const bits = chunk.bits[w] & mask;
                if (bits != 0) return (key << chunk_shift) + (w * 64 + (63 - @clz(bits))) * 8;
                if (w == 0) break;
                w -= 1;
                mask = ~@as(u64, 0);
            }
        }
        if (key == 0 or left == 0) return null;
        key -= 1;
        left -= 1;
        limit = .{ .word = 127, .bit = 63 };
    }
}

/// The block `addr` points into, prefix included, or null.
fn findBlock(addr: usize) ?*Header {
    if (addr < heap_lo or addr >= heap_hi) return null;
    // Blocks do not overlap, so the nearest start below is the only candidate; a small block is
    // at most a chunk long, so its start is at most one chunk back.
    if (startBelow(addr, 1)) |start| {
        const block: *Header = @ptrFromInt(start);
        return if (addr < start + blockBytes(block)) block else null;
    }
    const at = largeLowerBound(addr + 1);
    if (at == 0) return null;
    const block: *Header = @ptrFromInt(large.items[at - 1]);
    return if (addr < @intFromPtr(block) + blockBytes(block)) block else null;
}

/// The live object `obj` addresses, or null: NULL, static objects, malloc'd memory, buffers.
fn objectBlock(obj: usize) ?*Header {
    if (obj < prefix or !isBlockStart(obj - prefix)) return null;
    const block = blockOf(obj);
    if (block.word & (buffer_bit | dead_bit | swept_bit) != 0) return null;
    return block;
}

// ---------------------------------------------------------------- state

const Range = struct { lo: usize, hi: usize };
var data_ranges: [32]Range = undefined;
var data_range_count: usize = 0;

var zct: List(*Header) = .{};
var pinned: List(*Header) = .{};
var retired: List(*Header) = .{};
/// Live buffers a root word pointed into this collection; their root bits are cleared after it.
var rooted_buffers: List(*Header) = .{};

/// A dirty object and the slice of `log` holding the references it had when it became dirty.
const Entry = struct { block: *Header, start: usize, len: usize };
var dirty: List(Entry) = .{};
var log: List(*Header) = .{};
/// Every object allocated since the last collection; the ones still young after it are dead.
var young: List(*Header) = .{};
/// Young objects found alive whose references are not counted yet.
var survivors: List(*Header) = .{};
// The lists a collection swaps out, kept to be swapped back in: freeing and regrowing multi-MiB
// lists every collection leaves malloc's large-block cache holding hundreds of MiB.
var spare_dirty: List(Entry) = .{};
var spare_log: List(*Header) = .{};
var spare_zct: List(*Header) = .{};

var live_bytes: usize = 0;
var allocated_since: usize = 0;
const min_threshold: usize = 8 * 1024 * 1024;
var threshold: usize = min_threshold;
var collecting = false;
var trace_pauses = false;
var initialized = false;
var gc_stress = false;

/// The sanitized flavor (ReleaseSafe) allocates every block with malloc, so ASan sees each free;
/// the pools would hand the memory straight back out.
const use_pools = builtin.mode != .safe;

// ---------------------------------------------------------------- threads

/// One record per registered thread: what the collector reads while that thread is stopped.
const Thread = struct {
    frames: *[*c]c.JSRTFrame,
    pending: [*c]Value,
    handoff: *Value,
    stack_high: usize,
    sp: usize = 0,
    regs: [16]usize = @splat(0),
    stopped: bool = false,
    next: ?*Thread = null,
};

var threads: ?*Thread = null;
var thread_count: usize = 0;
threadlocal var self_thread: Thread = undefined;
threadlocal var registered = false;
threadlocal var handoff: Value = c.JSRT_UNDEFINED;
threadlocal var lock_depth: usize = 0;
threadlocal var lock_held = false;

var concurrent = std.atomic.Value(bool).init(false);
var stop_requested = std.atomic.Value(bool).init(false);
var heap_mutex: std.c.pthread_mutex_t = .{};
var stw_mutex: std.c.pthread_mutex_t = .{};
var stopped_cond: std.c.pthread_cond_t = .{};
var resume_cond: std.c.pthread_cond_t = .{};
var stopped_count: usize = 0;

fn pthreadOk(rc: std.c.E, what: [*:0]const u8) void {
    if (rc != .SUCCESS) c.jsrt_panic(what);
}

/// The callee-saved registers, where a caller's live pointers may sit across the call that
/// stops this thread. Caller-saved ones are dead across any call, so they need no saving.
noinline fn saveRegisters(out: *[16]usize) void {
    switch (builtin.cpu.arch) {
        .aarch64 => asm volatile (
            \\stp x19, x20, [%[o], #0]
            \\stp x21, x22, [%[o], #16]
            \\stp x23, x24, [%[o], #32]
            \\stp x25, x26, [%[o], #48]
            \\stp x27, x28, [%[o], #64]
            \\stp x29, x30, [%[o], #80]
            :
            : [o] "r" (out),
            : .{ .memory = true }),
        .x86_64 => asm volatile (
            \\movq %%rbx, 0(%[o])
            \\movq %%rbp, 8(%[o])
            \\movq %%r12, 16(%[o])
            \\movq %%r13, 24(%[o])
            \\movq %%r14, 32(%[o])
            \\movq %%r15, 40(%[o])
            :
            : [o] "r" (out),
            : .{ .memory = true }),
        else => @compileError("the collector saves registers on aarch64 and x86_64 only"),
    }
}

/// Publishes this thread's stack top and registers. Every frame above this one belongs to a caller
/// that stays suspended until the thread runs on.
noinline fn publishStack() void {
    saveRegisters(&self_thread.regs);
    self_thread.sp = @frameAddress();
}

fn markStopped() void {
    pthreadOk(std.c.pthread_mutex_lock(&stw_mutex), "collector: stop lock");
    self_thread.stopped = true;
    stopped_count += 1;
    _ = std.c.pthread_cond_broadcast(&stopped_cond);
    _ = std.c.pthread_mutex_unlock(&stw_mutex);
}

fn waitResumed() void {
    pthreadOk(std.c.pthread_mutex_lock(&stw_mutex), "collector: stop lock");
    while (stop_requested.load(.acquire)) _ = std.c.pthread_cond_wait(&resume_cond, &stw_mutex);
    self_thread.stopped = false;
    stopped_count -= 1;
    _ = std.c.pthread_mutex_unlock(&stw_mutex);
}

/// A registered thread about to block in native code (a mutex, a condition, a join) counts as
/// stopped until `leaveBlocking`: it cannot reach a safepoint while it waits.
pub fn enterBlocking() void {
    if (!registered or !concurrent.load(.acquire) or self_thread.stopped) return;
    publishStack();
    markStopped();
}

pub fn leaveBlocking() void {
    if (!registered or !self_thread.stopped) return;
    waitResumed();
}

export fn jsrt_gc_enter_blocking() void {
    enterBlocking();
}

export fn jsrt_gc_leave_blocking() void {
    leaveBlocking();
}

/// Mutual exclusion over the counts, the pools, the index and the lists while threads run.
/// Reentrant: a collection's frees reach code that locks again. Waiting for it is blocking, since
/// the holder may be collecting and waiting for this thread to stop.
fn lock() void {
    if (lock_depth != 0) {
        lock_depth += 1;
        return;
    }
    lock_depth = 1;
    if (!isConcurrent()) return;
    if (std.c.pthread_mutex_trylock(&heap_mutex) != .SUCCESS) {
        enterBlocking();
        pthreadOk(std.c.pthread_mutex_lock(&heap_mutex), "collector: heap lock");
        // Only the holder of heap_mutex stops the world, so no stop is in progress now.
        leaveBlocking();
    }
    lock_held = true;
}

fn unlock() void {
    lock_depth -= 1;
    if (lock_depth != 0 or !lock_held) return;
    lock_held = false;
    pthreadOk(std.c.pthread_mutex_unlock(&heap_mutex), "collector: heap unlock");
}

fn stopWorld() void {
    setStopped(true);
}

fn resumeWorld() void {
    setStopped(false);
}

fn setStopped(stop: bool) void {
    if (!isConcurrent()) return;
    pthreadOk(std.c.pthread_mutex_lock(&stw_mutex), "collector: stop lock");
    stop_requested.store(stop, .release);
    if (stop) {
        const others = thread_count - @intFromBool(registered);
        while (stopped_count < others) _ = std.c.pthread_cond_wait(&stopped_cond, &stw_mutex);
    } else {
        _ = std.c.pthread_cond_broadcast(&resume_cond);
    }
    _ = std.c.pthread_mutex_unlock(&stw_mutex);
}

fn stackHigh() usize {
    if (stack.currentBounds()) |b| return b.high;
    c.jsrt_panic("collector: cannot find this thread's stack");
}

fn register() void {
    self_thread = .{
        .frames = &c.jsrt_frame_top,
        .pending = c.jsrt_pending_slot(),
        .handoff = &handoff,
        .stack_high = stackHigh(),
    };
    pthreadOk(std.c.pthread_mutex_lock(&stw_mutex), "collector: stop lock");
    self_thread.next = threads;
    threads = &self_thread;
    thread_count += 1;
    registered = true;
    _ = std.c.pthread_mutex_unlock(&stw_mutex);
}

fn unregister() void {
    pthreadOk(std.c.pthread_mutex_lock(&stw_mutex), "collector: stop lock");
    var link = &threads;
    while (link.*) |node| : (link = &node.next) {
        if (node == &self_thread) {
            link.* = node.next;
            break;
        }
    }
    thread_count -= 1;
    registered = false;
    _ = std.c.pthread_mutex_unlock(&stw_mutex);
}

/// Once set before publishing the first worker, concurrency stays enabled. Runtime operations
/// that cannot start workers may omit their own mutex until this transition, like heap access.
pub fn isConcurrent() bool {
    return concurrent.load(.acquire);
}

pub fn enableThreads() void {
    concurrent.store(true, .release);
}

/// A worker registers before its first Stator allocation and leaves after publishing its result.
pub fn enterThread() void {
    if (registered) return;
    enableThreads();
    lock();
    defer unlock();
    register();
}

pub fn leaveThread() void {
    jsrt_gc_safepoint();
    if (!registered) return;
    lock();
    defer unlock();
    unregister();
}

/// A generated statement boundary: a thread a collection asked to stop stops here.
pub export fn jsrt_gc_safepoint() void {
    handoff = c.JSRT_UNDEFINED;
    if (registered and stop_requested.load(.acquire)) {
        publishStack();
        markStopped();
        waitResumed();
    }
}

/// A native return publishes the value it boxed until the caller's next statement boundary.
pub export fn jsrt_gc_handoff(value: Value) Value {
    if (concurrent.load(.acquire)) handoff = value;
    return value;
}

// ---------------------------------------------------------------- the image

const Dlinfo = extern struct {
    dli_fname: ?[*:0]const u8,
    dli_fbase: ?*anyopaque,
    dli_sname: ?[*:0]const u8,
    dli_saddr: ?*anyopaque,
};
extern "c" fn dladdr(addr: *const anyopaque, info: *Dlinfo) c_int;

fn addData(lo: usize, hi: usize) void {
    if (hi <= lo) return;
    if (data_range_count == data_ranges.len) c.jsrt_panic("collector: too many writable segments");
    data_ranges[data_range_count] = .{ .lo = lo, .hi = hi };
    data_range_count += 1;
}

/// The 64-bit segment commands of a Mach-O image, in load-command order.
const MachSegments = struct {
    cmd: [*]const u8,
    left: u32,

    fn next(it: *MachSegments) ?*const std.macho.segment_command_64 {
        while (it.left > 0) {
            const at = it.cmd;
            const lc: *const std.macho.load_command = @ptrCast(@alignCast(at));
            it.cmd += lc.cmdsize;
            it.left -= 1;
            if (lc.cmd == .SEGMENT_64) return @ptrCast(@alignCast(at));
        }
        return null;
    }
};

/// The writable segments of the image (executable or shared object) this runtime copy is linked
/// into: static caches and queues hold values there, so they are conservative roots.
fn imageInit() void {
    const here: *const anyopaque = @ptrCast(&jsrt_gc_init);
    switch (builtin.os.tag) {
        .macos, .ios, .tvos, .watchos, .visionos => {
            var info: Dlinfo = undefined;
            if (dladdr(here, &info) == 0) c.jsrt_panic("collector: cannot find the runtime's image");
            const header: *const std.macho.mach_header_64 = @ptrCast(@alignCast(info.dli_fbase orelse c.jsrt_panic("collector: no image base")));
            const all: MachSegments = .{ .cmd = @as([*]const u8, @ptrCast(header)) + @sizeOf(std.macho.mach_header_64), .left = header.ncmds };
            var slide: ?usize = null;
            var segs = all;
            while (segs.next()) |seg| {
                if (std.mem.eql(u8, std.mem.sliceTo(&seg.segname, 0), "__TEXT")) slide = @intFromPtr(header) -% seg.vmaddr;
            }
            const s = slide orelse c.jsrt_panic("collector: image has no __TEXT");
            segs = all;
            while (segs.next()) |seg| {
                if (seg.vmsize != 0 and seg.initprot.WRITE) {
                    const lo = seg.vmaddr +% s;
                    addData(lo, lo + seg.vmsize);
                }
            }
        },
        .linux => {
            _ = std.c.dl_iterate_phdr(phdrCallback, @constCast(here));
            if (data_range_count == 0) c.jsrt_panic("collector: cannot find the runtime's image");
        },
        else => @compileError("the collector reads images on macOS and Linux only"),
    }
}

fn phdrCallback(info: *std.c.dl_phdr_info, size: usize, data: ?*anyopaque) callconv(.c) c_int {
    _ = size;
    const target = @intFromPtr(data);
    const phdrs = info.phdr[0..info.phnum];
    const mine = for (phdrs) |ph| {
        const lo = info.addr + ph.vaddr;
        if (ph.type == .LOAD and target >= lo and target < lo + ph.memsz) break true;
    } else false;
    if (!mine) return 0;
    for (phdrs) |ph| {
        if (ph.type == .LOAD and ph.flags.W) addData(info.addr + ph.vaddr, info.addr + ph.vaddr + ph.memsz);
    }
    return 1;
}

// ---------------------------------------------------------------- tracing helpers

inline fn isPointerValue(v: Value) bool {
    return (v & c.JSRT_NANBOX_MASK) == c.JSRT_NANBOX_MASK and ((v >> c.JSRT_TAG_SHIFT) & 7) >= c.JSRT_TAG_OBJECT;
}

/// For Zig kinds' traces: the child a boxed value names, if it names one.
pub inline fn visitValue(v: Value, visit: c.jsrt_gc_visit_fn) void {
    if (isPointerValue(v)) visit.?(@ptrFromInt(v & mem.payload_mask));
}

pub inline fn visitValues(values: []const Value, visit: c.jsrt_gc_visit_fn) void {
    for (values) |v| visitValue(v, visit);
}

/// The traces of every kind report runtime pointers; these keep the collected ones as blocks.
fn traceBlocks(block: *Header, comptime onChild: fn (*Header) void) void {
    const visit = struct {
        fn visit(child: ?*anyopaque) callconv(.c) void {
            if (objectBlock(@intFromPtr(child))) |b| onChild(b);
        }
    }.visit;
    const k = kindOf(block);
    const base: [*]const u8 = @ptrCast(objOf(block));
    for (k.value_offsets[0..k.value_count]) |off| {
        visitValue(@as(*align(1) const Value, @ptrCast(base + off)).*, visit);
    }
    if (k.trace) |trace| trace(objOf(block), visit);
}

fn logChild(child: *Header) void {
    log.push(child);
}

fn incChild(child: *Header) void {
    child.word += 1;
    survive(child);
}

/// A young object a root or a counted reference names is alive; its own references are counted
/// when `reconcile` reaches it.
fn survive(block: *Header) void {
    if (block.word & young_bit == 0) return;
    block.word &= ~young_bit;
    survivors.push(block);
}

fn zctPush(block: *Header) void {
    if (block.word & zct_bit != 0) return;
    block.word |= zct_bit;
    zct.push(block);
}

/// Deferred counting never counts a root's reference, so the decrement that makes an object a
/// cycle candidate under plain counting -- the last root letting go -- never happens. An object a
/// root may have let go of since the last collection (a new one, a pinned one) that still has a
/// count is therefore a candidate. Trial deletion runs at the next collection, after that
/// collection's roots are pinned, so a cycle a root still holds survives it.
fn suspect(block: *Header) void {
    if (isCyclic(block)) collector.rt_cc_possible_root(block);
}

fn decChild(child: *Header) void {
    if (count(child) == 0) c.jsrt_panic("collector: a count fell below zero");
    child.word -= 1;
    if (count(child) == 0) {
        zctPush(child);
    } else if (isCyclic(child)) {
        collector.rt_cc_possible_root(child);
    }
}

// ---------------------------------------------------------------- the kxgc vtable

threadlocal var kx_visit: c.jsrt_gc_visit_fn = null;

/// `rel`: drop one reference. Trial deletion calls it on a dead cycle's acyclic children.
pub export fn jsrt_gc_vt_rel(block: ?*anyopaque) callconv(.c) void {
    decChild(@ptrCast(@alignCast(block orelse return)));
}

/// `trav`: the kind's own trace, reported as blocks.
pub export fn jsrt_gc_vt_trav(block: ?*anyopaque, visit: c.jsrt_gc_visit_fn) callconv(.c) void {
    const saved = kx_visit;
    kx_visit = visit;
    defer kx_visit = saved;
    traceBlocks(@ptrCast(@alignCast(block orelse return)), struct {
        fn f(child: *Header) void {
            kx_visit.?(child);
        }
    }.f);
}

/// `freemem`: trial deletion found the object dead and released what it had to.
pub export fn jsrt_gc_vt_freemem(block: ?*anyopaque) callconv(.c) void {
    const h: *Header = @ptrCast(@alignCast(block orelse return));
    finalize(h);
    freeBlock(h);
}

fn finalize(h: *Header) void {
    if (kindOf(h).finalize) |f| f(objOf(h));
}

// ---------------------------------------------------------------- allocation

/// The watched object's address, complemented: a plain copy in static storage would be a root.
var watched_hidden: usize = 0;
var watched_flag: c_int = 0;

fn rawAlloc(total: usize, what: [*:0]const u8) *Header {
    return rawAllocOrNull(total) orelse oom(what);
}

fn rawAllocOrNull(total: usize) ?*Header {
    const raw = if (use_pools) collector.rt_alloc_trace(@intCast(total)) else collector.rt_alloc(@intCast(total));
    const block: *Header = @ptrCast(@alignCast(raw orelse return null));
    @memset(@as([*]u8, @ptrCast(block))[0..total], 0);
    indexInsert(block, total);
    live_bytes += total;
    allocated_since += total;
    return block;
}

fn rawFree(h: *Header) void {
    const bytes = blockBytes(h);
    if (watched_hidden != 0 and ~watched_hidden == objAddr(h)) {
        watched_flag = 1;
        watched_hidden = 0;
    }
    indexRemove(h, bytes);
    live_bytes -|= bytes;
    if (use_pools) collector.rt_free_trace(h, @intCast(bytes)) else collector.rt_free(h, @intCast(bytes));
}

/// A finalized object. A list that still names it -- the ZCT, the dirty list -- releases the
/// memory when it reaches it.
fn freeBlock(h: *Header) void {
    if (h.word & (zct_bit | dirty_bit) != 0) {
        h.word |= dead_bit;
    } else {
        rawFree(h);
    }
}

fn maybeCollect() void {
    if (collecting or !initialized) return;
    if (gc_stress or allocated_since >= threshold) collectLocked();
}

pub fn alloc(bytes: usize, kind_: *const Kind) *anyopaque {
    const total = blockTotal(bytes, kind_.name);
    // Before worker publication there is no mutex to own and no reentrancy depth to track.
    // Avoid two thread-local lookups for every single-thread allocation.
    const shared = isConcurrent();
    if (shared) lock();
    defer if (shared) unlock();
    maybeCollect();
    const block = rawAlloc(total, kind_.name);
    // Dirty, so `jsrt_gc_write` returns at once: a young object's references are counted only if
    // it survives, and then all of them.
    block.* = .{ .word = sizeWord(total) | young_bit | dirty_bit, .meta = @intFromPtr(kind_) };
    young.push(block);
    return objOf(block);
}

pub export fn jsrt_gc_alloc(bytes: usize, kind_: *const Kind) *anyopaque {
    return alloc(bytes, kind_);
}

/// "out of memory: <what>", truncated to the 128-byte message the C runtime has always used.
fn oom(what: [*:0]const u8) noreturn {
    @branchHint(.cold);
    const lead = "out of memory: ";
    var msg: [128]u8 = undefined;
    const name = std.mem.span(what);
    const n = @min(name.len, msg.len - 1 - lead.len);
    @memcpy(msg[0..lead.len], lead);
    @memcpy(msg[lead.len..][0..n], name[0..n]);
    msg[lead.len + n] = 0;
    c.jsrt_panic(@ptrCast(&msg));
}

// ---------------------------------------------------------------- the write barrier

/// The live object `addr` points into, or whose buffer it points into.
fn ownerBlock(addr: usize) ?*Header {
    const block = findBlock(addr) orelse return null;
    if (block.word & (dead_bit | swept_bit) != 0) return null;
    if (block.word & buffer_bit != 0) return objectBlock(block.meta);
    return block;
}

/// Called before a runtime function changes the references inside an existing object. `obj` may
/// point anywhere inside the object or inside a buffer it owns, so a caller holding only an
/// element pointer can name its owner. NULL, a static object and anything else that is not a
/// collected object are ignored.
pub export fn jsrt_gc_write(obj: ?*const anyopaque) void {
    _ = writeOwner(obj orelse return);
}

/// Apply the barrier and return the buffer owner in the same lookup. For a static field,
/// return its address: no object starts there, so its buffer is scanned as a root (`pin`).
pub fn writeOwner(obj: *const anyopaque) *const anyopaque {
    // The common case, an object already dirty and named by its own address, without the lock.
    // Only while one thread runs: another could be growing the index this reads.
    const addr = @intFromPtr(obj);
    if (!concurrent.load(.monotonic) and addr >= prefix and isBlockStart(addr - prefix)) {
        if (blockOf(addr).word & dirty_bit != 0) return obj;
    }
    lock();
    defer unlock();
    const block = ownerBlock(addr) orelse return obj;
    const owner = objOf(block);
    if (block.word & dirty_bit != 0) return owner;
    block.word |= dirty_bit;
    const start = log.len;
    traceBlocks(block, logChild);
    dirty.push(.{ .block = block, .start = start, .len = log.len - start });
    return owner;
}

pub fn write(obj: anytype) void {
    jsrt_gc_write(@ptrCast(obj));
}

// ---------------------------------------------------------------- buffers

/// Storage `owner` holds outright -- elements, entries, slots -- zeroed. Never counted: the owner's
/// kind traces what it holds and frees it in its finalizer.
pub fn buffer(owner: ?*const anyopaque, bytes: usize, what: [*:0]const u8) *anyopaque {
    const total = blockTotal(bytes, what);
    lock();
    defer unlock();
    maybeCollect();
    const block = rawAlloc(total, what);
    block.* = .{ .word = sizeWord(total) | buffer_bit, .meta = @intFromPtr(owner) };
    return objOf(block);
}

/// `buffer`, or null when the size is past the collector's limit or the system refuses it: for
/// storage whose failure the program can catch (an ArrayBuffer's bytes).
pub fn bufferOrNull(owner: ?*const anyopaque, bytes: usize) ?*anyopaque {
    if (bytes > (size_field << 12) - 4096) return null;
    const total = prefix + std.mem.alignForward(usize, if (bytes == 0) 1 else bytes, 8);
    const sized = if (total / 8 <= size_field) total else std.mem.alignForward(usize, total, 4096);
    lock();
    defer unlock();
    maybeCollect();
    const block = rawAllocOrNull(sized) orelse return null;
    block.* = .{ .word = sizeWord(sized) | buffer_bit, .meta = @intFromPtr(owner) };
    return objOf(block);
}

fn bufferBlock(p: ?*const anyopaque) ?*Header {
    const addr = @intFromPtr(p orelse return null);
    if (addr < prefix or !isBlockStart(addr - prefix)) c.jsrt_panic("collector: not a buffer");
    const block = blockOf(addr);
    if (block.word & buffer_bit == 0) c.jsrt_panic("collector: not a buffer");
    return block;
}

/// Bytes the buffer `p` can hold (at least what was asked for it).
pub fn bufferBytes(p: ?*const anyopaque) usize {
    lock();
    defer unlock();
    return blockBytes(bufferBlock(p) orelse return 0) - prefix;
}

/// Names the buffer's owner, when the buffer was made before it.
pub fn bufferAdopt(p: ?*const anyopaque, owner: ?*const anyopaque) void {
    lock();
    defer unlock();
    (bufferBlock(p) orelse return).meta = @intFromPtr(owner);
}

/// From a finalizer: the owner is dead, and a root inside the buffer would have kept it alive.
pub fn bufferFree(p: ?*const anyopaque) void {
    lock();
    defer unlock();
    rawFree(bufferBlock(p) orelse return);
}

/// A buffer its living owner replaced. A runtime local may still point into it, so it is freed
/// at a collection that finds no root word inside it.
pub fn bufferRetire(p: ?*const anyopaque) void {
    lock();
    defer unlock();
    const block = bufferBlock(p) orelse return;
    block.meta = 0;
    retired.push(block);
}

/// A fresh buffer of `bytes` holding the start of `p` (null: none yet), the rest zeroed; `p` is
/// retired.
pub fn bufferResize(owner: ?*const anyopaque, p: ?*const anyopaque, bytes: usize, what: [*:0]const u8) *anyopaque {
    const fresh = buffer(owner, bytes, what);
    if (p) |old| {
        const keep = @min(bufferBytes(old), bytes);
        @memcpy(@as([*]u8, @ptrCast(fresh))[0..keep], @as([*]const u8, @ptrCast(old))[0..keep]);
        bufferRetire(old);
    }
    return fresh;
}

/// Temporary storage for values a runtime function builds before it has an object to put them in.
/// While a root points into it, every word in it is a root too; free it with `bufferFree`.
pub fn scratch(bytes: usize, what: [*:0]const u8) *anyopaque {
    // Any owner that is not a collected object makes `pin` scan the buffer.
    return buffer(@ptrFromInt(scratch_owner), bytes, what);
}

const scratch_owner: usize = 1;

export fn jsrt_gc_scratch(bytes: usize, what: [*:0]const u8) *anyopaque {
    return scratch(bytes, what);
}

export fn jsrt_gc_buffer(owner: ?*const anyopaque, bytes: usize, what: [*:0]const u8) *anyopaque {
    return buffer(owner, bytes, what);
}

export fn jsrt_gc_buffer_adopt(p: ?*const anyopaque, owner: ?*const anyopaque) void {
    bufferAdopt(p, owner);
}

export fn jsrt_gc_buffer_free(p: ?*const anyopaque) void {
    bufferFree(p);
}

export fn jsrt_gc_buffer_retire(p: ?*const anyopaque) void {
    bufferRetire(p);
}

export fn jsrt_gc_buffer_resize(owner: ?*const anyopaque, p: ?*const anyopaque, bytes: usize, what: [*:0]const u8) *anyopaque {
    return bufferResize(owner, p, bytes, what);
}

// ---------------------------------------------------------------- collection

fn pin(block: *Header) void {
    if (block.word & (root_bit | dead_bit | swept_bit) != 0) return;
    block.word |= root_bit;
    if (block.word & buffer_bit != 0) {
        rooted_buffers.push(block);
        // A retired buffer (meta 0) roots only itself: its owner holds a copy of what it held.
        if (block.meta == 0) return;
        if (objectBlock(block.meta)) |owner| {
            pin(owner);
        } else {
            // A static object's storage: no count covers what it holds, so it is a root range.
            scanRange(objAddr(block), @intFromPtr(block) + blockBytes(block));
        }
        return;
    }
    block.word += 1;
    pinned.push(block);
    survive(block);
}

fn noteWord(w: usize) void {
    if (findBlock(w & mem.payload_mask)) |block| pin(block);
}

fn scanRange(lo: usize, hi: usize) void {
    var p = std.mem.alignForward(usize, lo, @sizeOf(usize));
    while (p + @sizeOf(usize) <= hi) : (p += @sizeOf(usize)) noteWord(@as(*const usize, @ptrFromInt(p)).*);
}

fn scanThread(t: *Thread) void {
    var frame: ?*const c.JSRTFrame = t.frames.*;
    while (frame) |f| : (frame = f.prev) {
        for (0..f.count) |i| noteWord(f.slots[i]);
        noteWord(@intFromPtr(f.env));
    }
    noteWord(t.pending.*);
    noteWord(t.handoff.*);
    for (t.regs) |r| noteWord(r);
    if (t.sp != 0 and t.sp < t.stack_high) scanRange(t.sp, t.stack_high);
}

fn gatherRoots() void {
    var t = threads;
    while (t) |thread| : (t = thread.next) scanThread(thread);
    for (data_ranges[0..data_range_count]) |r| scanRange(r.lo, r.hi);
}

/// Brings every dirty object's references into the counts, and decides which stay dirty: those a
/// root names (a runtime function may be part way through changing them) and the always-dirty
/// kinds. A kept entry logs the references it holds now.
fn reconcile() void {
    var entries = dirty;
    var old_log = log;
    dirty = spare_dirty;
    log = spare_log;
    for (entries.slice()) |e| {
        const block = e.block;
        traceBlocks(block, incChild);
        for (old_log.items[e.start .. e.start + e.len]) |child| decChild(child);
        keepDirtyOrClean(block);
    }
    // Survivors were born dirty with nothing counted: all their references are new.
    while (survivors.pop()) |block| {
        traceBlocks(block, incChild);
        keepDirtyOrClean(block);
    }
    entries.len = 0;
    old_log.len = 0;
    spare_dirty = entries;
    spare_log = old_log;
}

fn keepDirtyOrClean(block: *Header) void {
    if (block.word & root_bit != 0 or kindOf(block).always_dirty != 0) {
        const start = log.len;
        traceBlocks(block, logChild);
        dirty.push(.{ .block = block, .start = start, .len = log.len - start });
    } else {
        block.word &= ~dirty_bit;
    }
}

/// The young objects nothing found: nothing counted references them and they counted nothing.
fn freeYoung() void {
    for (young.slice()) |block| {
        if (block.word & young_bit == 0) continue;
        finalize(block);
        rawFree(block);
    }
    young.len = 0;
}

fn sweepChild(child: *Header) void {
    decChild(child);
}

/// Frees every ZCT entry no root names. Freeing releases references, which may add entries that
/// the same pass then considers; entries a root names wait for the next collection.
fn sweepZct() void {
    var keep = spare_zct;
    while (zct.pop()) |block| {
        if (block.word & dead_bit != 0) {
            block.word &= ~zct_bit;
            if (block.word & dirty_bit == 0) rawFree(block);
            continue;
        }
        if (count(block) != 0) {
            block.word &= ~zct_bit;
            suspect(block);
            continue;
        }
        if (block.word & root_bit != 0) {
            keep.push(block);
            continue;
        }
        block.word &= ~zct_bit;
        traceBlocks(block, sweepChild);
        if (block.word & kx.BUF_BIT != 0) {
            // Trial deletion holds it as a candidate and frees it when it next drains, finding
            // it black at count zero (kxgc.h); until then nothing may count it again.
            block.word = (block.word & ~kx.COLOR_MASK) | swept_bit;
        } else {
            finalize(block);
            freeBlock(block);
        }
    }
    spare_zct = zct;
    zct = keep;
}

/// Releases the dirty list's hold on objects this collection finalized.
fn compactDirty() void {
    var kept: usize = 0;
    for (dirty.slice()) |e| {
        if (e.block.word & dead_bit != 0) {
            e.block.word &= ~dirty_bit;
            if (e.block.word & zct_bit == 0) rawFree(e.block);
        } else {
            dirty.items[kept] = e;
            kept += 1;
        }
    }
    dirty.len = kept;
}

/// Before the rooted buffers' root bits are cleared: those bits are what keep a retired one.
fn sweepRetired() void {
    var kept: usize = 0;
    for (retired.slice()) |block| {
        if (block.word & root_bit != 0) {
            retired.items[kept] = block;
            kept += 1;
        } else {
            rawFree(block);
        }
    }
    retired.len = kept;
}

/// One collection. Caller holds the heap lock.
fn collectLocked() void {
    if (collecting) return;
    collecting = true;
    defer collecting = false;
    const started = if (trace_pauses) host.rt_nanos() else 0;
    // Registered first so reporting happens after resumeWorld, outside the stopped interval.
    defer if (trace_pauses) {
        const elapsed = host.rt_nanos() - started;
        var buf: [192]u8 = undefined;
        const line = std.fmt.bufPrint(&buf, "stator-gc: {{\"pauseNs\":{d},\"liveBytes\":{d}}}\n", .{ elapsed, live_bytes }) catch unreachable;
        _ = std.c.write(2, line.ptr, line.len);
    };
    stopWorld();
    defer resumeWorld();
    if (registered) publishStack();
    gatherRoots();
    reconcile();
    freeYoung();
    if (verify) verifyCounts();
    host.rt_rel_draining = 0;
    collector.rt_gc_collect();
    host.rt_rel_draining = 1;
    for (pinned.slice()) |block| {
        block.word -= 1;
        if (count(block) == 0) zctPush(block) else suspect(block);
    }
    sweepZct();
    for (pinned.slice()) |block| block.word &= ~root_bit;
    pinned.len = 0;
    compactDirty();
    sweepRetired();
    for (rooted_buffers.slice()) |block| block.word &= ~root_bit;
    rooted_buffers.len = 0;
    allocated_since = 0;
    threshold = @max(min_threshold, live_bytes);
}

export fn jsrt_gc_collect() void {
    if (!initialized) return;
    lock();
    defer unlock();
    collectLocked();
}

// ---------------------------------------------------------------- the verifier

/// `JSRT_GC_VERIFY=1`: after reconciling, recount every reference from the heap and compare. A
/// mismatch names the kind whose writes skipped `jsrt_gc_write`, or whose trace misses a field.
var verify = false;
var edges: List(usize) = .{};

fn eachBlock(comptime f: fn (*Header) void) void {
    for (0..index.cap) |i| {
        const chunk = index.chunks[i] orelse continue;
        const base = index.keys[i] << chunk_shift;
        for (chunk.bits, 0..) |word, w| {
            var bits = word;
            while (bits != 0) {
                const bit = @ctz(bits);
                bits &= bits - 1;
                f(@ptrFromInt(base + (w * 64 + bit) * 8));
            }
        }
    }
}

fn edgeChild(child: *Header) void {
    edges.push(@intFromPtr(child));
}

fn collectEdges(block: *Header) void {
    if (block.word & (buffer_bit | dead_bit | swept_bit) != 0) return;
    traceBlocks(block, edgeChild);
}

fn order(key: usize, item: usize) std.math.Order {
    return std.math.order(key, item);
}

fn lessThan(_: void, a: usize, b: usize) bool {
    return a < b;
}

fn checkBlock(block: *Header) void {
    if (block.word & (buffer_bit | dead_bit | swept_bit) != 0) return;
    const all = edges.slice();
    const p = @intFromPtr(block);
    const want = (std.sort.upperBound(usize, all, p, order) - std.sort.lowerBound(usize, all, p, order)) +
        @intFromBool(block.word & root_bit != 0);
    if (count(block) == want) return;
    var msg: [200]u8 = undefined;
    const text = std.fmt.bufPrintSentinel(&msg, "collector verify: a {s} has count {d}, the heap holds {d}", .{ std.mem.span(kindOf(block).name), count(block), want }, 0) catch "collector verify: count mismatch";
    c.jsrt_panic(text.ptr);
}

fn verifyCounts() void {
    edges.len = 0;
    eachBlock(collectEdges);
    std.mem.sort(usize, edges.slice(), {}, lessThan);
    eachBlock(checkBlock);
}

// ---------------------------------------------------------------- test hooks and init

export fn jsrt_gc_stress(on: c_int) void {
    gc_stress = on != 0;
}

export fn jsrt_gc_watch(obj: ?*anyopaque) void {
    watched_hidden = ~@intFromPtr(obj);
    watched_flag = 0;
}

export fn jsrt_gc_watched_reset() void {
    watched_flag = 0;
}

export fn jsrt_gc_watched() c_int {
    return watched_flag;
}

/// Called by jsrt_init once the pointer-width assumption holds. Idempotent: two `--emit-header`
/// units linked against one libjsrt.a each call it from their own init (plan-notes 341).
pub export fn jsrt_gc_init() void {
    if (initialized) return;
    imageInit();
    register();
    if (std.c.getenv("JSRT_GC_VERIFY")) |v| verify = v[0] != 0 and v[0] != '0';
    // A library built with --emit=lib localizes jsrt_gc_stress, so a C host cannot reach its
    // private collector's hook; the environment can (ffi static-lib, plan/T66).
    if (std.c.getenv("JSRT_GC_STRESS")) |v| gc_stress = v[0] != 0 and v[0] != '0';
    if (std.c.getenv("JSRT_GC_TRACE")) |v| trace_pauses = v[0] != 0 and v[0] != '0';
    initialized = true;
}

pub const KindOptions = struct { cyclic: bool = true, always_dirty: bool = false };

/// The C callbacks around a kind's typed trace and finalizer, so no kind repeats the cast.
fn Callbacks(comptime T: type, comptime trace: ?fn (*T, c.jsrt_gc_visit_fn) void, comptime fin: ?fn (*T) void) type {
    return struct {
        fn traceC(obj: ?*anyopaque, visit: c.jsrt_gc_visit_fn) callconv(.c) void {
            trace.?(@ptrCast(@alignCast(obj orelse return)), visit);
        }
        fn finalizeC(obj: ?*anyopaque) callconv(.c) void {
            fin.?(@ptrCast(@alignCast(obj orelse return)));
        }
    };
}

/// A kind for a Zig-allocated `T`.
pub fn kind(
    comptime T: type,
    comptime name: [*:0]const u8,
    comptime trace: ?fn (*T, c.jsrt_gc_visit_fn) void,
    comptime fin: ?fn (*T) void,
    comptime opts: KindOptions,
) Kind {
    const cb = Callbacks(T, trace, fin);
    return .{
        .vtab = .{
            .rel = &jsrt_gc_vt_rel,
            .trav = &jsrt_gc_vt_trav,
            .relo = null,
            .freemem = &jsrt_gc_vt_freemem,
            .cyclic = if (opts.cyclic) @ptrFromInt(1) else null,
        },
        .name = name,
        .trace = if (trace != null) &cb.traceC else null,
        .finalize = if (fin != null) &cb.finalizeC else null,
        .always_dirty = @intFromBool(opts.always_dirty),
        .value_count = 0,
        .value_offsets = @splat(0),
    };
}
