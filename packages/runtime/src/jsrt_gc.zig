//! The one collected allocation, and the two hooks that make it correct (docs/VALUE.md §4.12).
//!
//! Boehm is a CONSERVATIVE collector: it scans memory word by word and retains anything that
//! looks like a heap address. A jsrt_value is not one. NaN-boxing puts the tag above bit 48, so a
//! boxed reference never looks like a pointer -- the collector walks straight past every value a
//! Map, an array, an object slot or a stack frame holds, and frees objects that are still live
//! (plan-notes 108: without these hooks a forced collection over a 200-entry Map SIGSEGVs).
//!
//! Boehm 8.2 has no GC_set_pointer_mask, so the two places a reference can hide each get an
//! explicit hook that unboxes before testing:
//!
//!   - the heap, via a custom object kind whose mark procedure masks every word it scans. Every
//!     collected allocation in the runtime comes from jsrt_gc_alloc, so the kind covers all of it.
//!   - the roots, via GC_set_push_other_roots over the JSRT_FRAME shadow stack. The hook CHAINS
//!     to the one it replaces: in a threads-enabled Boehm (every packaged one) that default is
//!     GC_push_all_stacks, i.e. the C stack and registers themselves. Replacing it outright meant a
//!     raw pointer in a runtime local was no root at all, and a function that allocates twice -- a
//!     Map's entries then its index, an array's header then its elements -- lost the first block to
//!     the second allocation's collection (plan-notes 163).
//!
//! Masking is safe for BOTH word shapes the runtime stores: a boxed value's payload is its low 48
//! bits, and a raw pointer's top 16 bits are zero, so the mask is the identity on raw pointers. A
//! word that is neither -- a double, a length -- can mask to a plausible address and retain one
//! object it does not own. That is ordinary conservative-collector behaviour: it costs memory,
//! never correctness.
//!
//! Without Boehm this is plain malloc and no collection, which is the configuration every machine
//! without bdw-gc installed builds. The justfile passes -DJSRT_HAVE_BOEHM to this object exactly
//! when it passes it to the C objects, and @cImport makes that macro visible here.

const std = @import("std");
const mem = @import("jsrt_mem.zig");
const c = mem.c;

/// Whether collected memory is Boehm's. Without it a collected block is plain malloc and is freed
/// by whoever drops it (jsrt_shape.zig's slot growth).
pub const boehm = @hasDecl(c, "JSRT_HAVE_BOEHM");

// A collector on another thread may stop a native return between boxing and the caller's
// frame store. Keep new allocations until a generated statement boundary acknowledges them.
const Allocation = struct { pointer: *anyopaque, next: ?*Allocation };
var concurrent = std.atomic.Value(bool).init(false);
threadlocal var allocations: ?*Allocation = null;
threadlocal var handoff: c.jsrt_value = c.JSRT_UNDEFINED;

pub fn enableThreads() void {
    concurrent.store(true, .release);
}
fn retain(pointer: *anyopaque) *anyopaque {
    if (boehm and concurrent.load(.acquire)) {
        const record: *Allocation = @ptrCast(@alignCast(std.c.malloc(@sizeOf(Allocation)) orelse c.jsrt_panic("thread allocation roots")));
        record.* = .{ .pointer = pointer, .next = allocations };
        allocations = record;
    }
    return pointer;
}
pub export fn jsrt_gc_safepoint() void {
    var record = allocations;
    allocations = null;
    handoff = c.JSRT_UNDEFINED;
    while (record) |node| {
        record = node.next;
        std.c.free(node);
    }
}
pub export fn jsrt_gc_handoff(value: c.jsrt_value) c.jsrt_value {
    if (concurrent.load(.acquire)) handoff = value;
    return value;
}

const impl = if (boehm) struct {
    const gc = @cImport({
        @cDefine("GC_THREADS", "1");
        @cInclude("gc.h");
        @cInclude("gc/gc_mark.h");
    });

    var kind: c_int = 0;

    /// The hook installed before ours: the C stack and registers of every thread in a
    /// threads-enabled Boehm, NULL in a single-threaded one (which scans its stack without a hook).
    var default_push_other_roots: gc.GC_push_other_roots_proc = null;

    fn mark(
        addr: [*c]gc.GC_word,
        msp: ?*gc.struct_GC_ms_entry,
        msl: ?*gc.struct_GC_ms_entry,
        env: gc.GC_word,
    ) callconv(.c) ?*gc.struct_GC_ms_entry {
        _ = env;
        // The header's size, so this works for every allocation shape the runtime has -- a fixed
        // struct, a flexible array member, a bare jsrt_value buffer -- without any of them carrying
        // a layout descriptor. It rounds up to the granule, so the tail may scan padding; padding is
        // inside the object's own block and cleared, so reading it is harmless.
        //
        // A mark procedure can also be handed a cleared object on a free list, whose first word is
        // a free-list link. Masking a raw pointer is the identity, so that word marks the next free
        // object: it retains one dead object for a cycle, and cannot corrupt anything.
        const words = gc.GC_size(addr) / @sizeOf(gc.GC_word);
        const least = @intFromPtr(gc.GC_least_plausible_heap_addr);
        const greatest = @intFromPtr(gc.GC_greatest_plausible_heap_addr);
        var sp = msp;
        for (0..words) |i| {
            const p = addr[i] & mem.payload_mask;
            // GC_MARK_AND_PUSH: the macro's plausibility test, then the call it guards.
            if (p >= least and p <= greatest) {
                sp = gc.GC_mark_and_push(@ptrFromInt(p), sp, msl, @ptrCast(&addr[i]));
            }
        }
        return sp;
    }

    /// Roots are pushed a chunk at a time through a plain array of RAW pointers, because the eager
    /// push scans a memory range conservatively -- which is precisely what fails on a boxed value.
    /// Unboxing into this buffer first is what makes the range scannable. The buffer is dead once
    /// the push returns: GC_push_all_eager marks its contents immediately rather than recording the
    /// range for later.
    const Roots = struct {
        raw: [128]?*anyopaque = undefined,
        n: usize = 0,

        fn add(self: *Roots, p: ?*anyopaque) void {
            self.raw[self.n] = p;
            self.n += 1;
            if (self.n == self.raw.len) self.flush();
        }

        fn flush(self: *Roots) void {
            if (self.n == 0) return;
            gc.GC_push_all_eager(@ptrCast(&self.raw), @ptrCast(self.raw[self.n..].ptr));
            self.n = 0;
        }
    };

    const ThreadRoots = struct {
        frames: *[*c]c.JSRTFrame,
        pending: [*c]c.jsrt_value,
        allocations: *?*Allocation,
        handoff: *c.jsrt_value,
        next: ?*ThreadRoots,
    };
    var threads: ?*ThreadRoots = null;
    threadlocal var own_roots: ThreadRoots = undefined;
    threadlocal var registered_here = false;

    fn addRoots(_: ?*anyopaque) callconv(.c) ?*anyopaque {
        own_roots = .{ .frames = &c.jsrt_frame_top, .pending = c.jsrt_pending_slot(), .allocations = &allocations, .handoff = &handoff, .next = threads };
        threads = &own_roots;
        return null;
    }

    fn removeRoots(_: ?*anyopaque) callconv(.c) ?*anyopaque {
        var link = &threads;
        while (link.*) |node| {
            if (node == &own_roots) {
                link.* = node.next;
                break;
            }
            link = &node.next;
        }
        return null;
    }

    fn enterThread() void {
        var base: gc.struct_GC_stack_base = undefined;
        if (gc.GC_get_stack_base(&base) != gc.GC_SUCCESS) c.jsrt_panic("thread stack registration failed");
        const result = gc.GC_register_my_thread(&base);
        if (result != gc.GC_SUCCESS and result != gc.GC_DUPLICATE) c.jsrt_panic("thread GC registration failed");
        registered_here = result == gc.GC_SUCCESS;
        _ = gc.GC_call_with_alloc_lock(addRoots, null);
    }

    fn leaveThread() void {
        _ = gc.GC_call_with_alloc_lock(removeRoots, null);
        if (registered_here) _ = gc.GC_unregister_my_thread();
    }

    fn pushRoots() callconv(.c) void {
        // First the C stack, conservatively, as if we had never been installed: every raw pointer
        // a runtime function holds in a local across an allocation depends on this. Then the frames.
        if (default_push_other_roots) |push| push();
        var roots: Roots = .{};
        var thread = threads;
        while (thread) |t| : (thread = t.next) {
            var frame: ?*const c.JSRTFrame = t.frames.*;
            while (frame) |f| : (frame = f.prev) {
                for (0..f.count) |i| roots.add(@ptrFromInt(f.slots[i] & mem.payload_mask));
                if (f.env != null) roots.add(@ptrCast(f.env));
            }
            roots.add(@ptrFromInt(t.pending.* & mem.payload_mask));
            roots.add(@ptrFromInt(t.handoff.* & mem.payload_mask));
            var allocation = t.allocations.*;
            while (allocation) |a| : (allocation = a.next) roots.add(a.pointer);
        }
        roots.flush();
    }

    fn init() void {
        // GC_INIT() is GC_init() plus configuration hooks, and gc.h leaves every one of them empty
        // on the platforms this runtime builds for (GC_INIT_CONF_ROOTS is non-empty only on
        // Cygwin/MinGW, AIX and dynamic-loading-less Android).
        gc.GC_init();
        gc.GC_allow_register_threads();
        _ = gc.GC_call_with_alloc_lock(addRoots, null);
        // The kind is registered once per PROCESS, not once per runtime copy. A `--emit=lib` archive
        // carries a private runtime (plan-notes 342), so one process can hold several copies of this
        // file, and Boehm aborts with "Too many kinds" once MAXOBJKINDS (16 in 8.2) are taken -- the
        // 13th library's init died there. `jsrt_gc_shared_kind_p48` (jsrt_mem.h) is a weak global the
        // library build keeps exported, so the copies coalesce on one definition and the first to
        // initialize registers the kind for all of them. Sharing is sound because every copy's `mark`
        // masks the same 48-bit payload; a runtime that marks differently must rename the symbol.
        if (c.jsrt_gc_shared_kind_p48 == 0) {
            c.jsrt_gc_shared_kind_p48 = gc.GC_new_kind(gc.GC_new_free_list(), gc.GC_MAKE_PROC(gc.GC_new_proc(mark), 0), 0, 1) + 1;
        }
        kind = @intCast(c.jsrt_gc_shared_kind_p48 - 1);
        default_push_other_roots = gc.GC_get_push_other_roots();
        gc.GC_set_push_other_roots(pushRoots);
    }

    fn alloc(bytes: usize) ?*anyopaque {
        return gc.GC_generic_malloc(bytes, kind);
    }

    /// Boehm's pointer-free kind: never scanned, and NOT cleared on allocation.
    fn allocAtomic(bytes: usize) ?*anyopaque {
        const p = gc.GC_malloc_atomic(bytes) orelse return null;
        @memset(@as([*]u8, @ptrCast(p))[0..bytes], 0);
        return p;
    }

    fn collect() void {
        gc.GC_gcollect();
    }

    /// `jsrt_gc_watch`: the test's proof that a boxed value was not a root. The finalizer runs
    /// from inside the collection that finds `obj` unreachable.
    var watched_flag: c_int = 0;

    fn watchedFinalizer(obj: ?*anyopaque, data: ?*anyopaque) callconv(.c) void {
        _ = obj;
        _ = data;
        watched_flag = 1;
    }

    fn watch(obj: *anyopaque) void {
        gc.GC_register_finalizer(obj, watchedFinalizer, null, null, null);
    }

    fn watched() c_int {
        return watched_flag;
    }

    fn watchedReset() void {
        watched_flag = 0;
    }
} else struct {
    fn init() void {}
    fn enterThread() void {}
    fn leaveThread() void {}

    fn alloc(bytes: usize) ?*anyopaque {
        return std.c.malloc(bytes);
    }

    fn collect() void {}

    fn allocAtomic(bytes: usize) ?*anyopaque {
        return std.c.calloc(bytes, 1);
    }

    fn watch(_: *anyopaque) void {}

    fn watched() c_int {
        return 0;
    }

    fn watchedReset() void {}
};

/// Whether this runtime copy has installed its kind and roots hook. Single-threaded, like every
/// runtime entry in v0 (docs/FFI.md §8).
var gc_initialized = false;

/// `jsrt_gc_stress`: a test collects before every allocation so an unrooted boxed value cannot
/// survive by accident of heap size. Re-entry is skipped: a collection must not collect again
/// from inside itself.
threadlocal var gc_stress = false;
threadlocal var gc_stress_collecting = false;

export fn jsrt_gc_stress(on: c_int) void {
    gc_stress = on != 0;
}

export fn jsrt_gc_watch(obj: *anyopaque) void {
    impl.watch(obj);
}

export fn jsrt_gc_watched_reset() void {
    impl.watchedReset();
}

export fn jsrt_gc_watched() c_int {
    return impl.watched();
}

/// Called by jsrt_init once the pointer-width assumption holds. Idempotent: two `--emit-header`
/// units linked against one libjsrt.a each call it from their own init, and a second install would
/// save `pushRoots` as its own predecessor -- the first collection then recurses until the stack
/// overflows (plan-notes 341).
export fn jsrt_gc_init() void {
    if (gc_initialized) return;
    gc_initialized = true;
    impl.init();
}

/// The runtime's ONE collected allocation (jsrt.h). A zero-byte request is a real one -- an empty
/// array literal still wants an element buffer -- and malloc may answer NULL for it, which is
/// indistinguishable from failure, so it asks for one granule instead. Never returns NULL.
fn stressCollect() void {
    if (gc_stress and !gc_stress_collecting) {
        gc_stress_collecting = true;
        impl.collect();
        gc_stress_collecting = false;
    }
}

pub fn alloc(bytes: usize, what: [*:0]const u8) *anyopaque {
    stressCollect();
    return retain(impl.alloc(if (bytes == 0) 1 else bytes) orelse oom(what));
}

/// A collected block the collector never scans, zero-filled: raw bytes (an ArrayBuffer's
/// contents), where a byte pattern that happens to look like an address must not retain anything.
/// Unlike `alloc` it answers NULL on failure, because a buffer's size is the program's choice and
/// a refusal is a RangeError the program can catch, not an internal panic.
pub fn allocAtomic(bytes: usize) ?*anyopaque {
    stressCollect();
    return retain(impl.allocAtomic(if (bytes == 0) 1 else bytes) orelse return null);
}

export fn jsrt_gc_alloc(bytes: usize, what: [*c]const u8) *anyopaque {
    return alloc(bytes, @ptrCast(what));
}

/// "out of memory: <what>", truncated to the 128-byte message the C runtime has always used.
fn oom(what: [*:0]const u8) noreturn {
    @branchHint(.cold);
    const prefix = "out of memory: ";
    var msg: [128]u8 = undefined;
    const name = std.mem.span(what);
    const n = @min(name.len, msg.len - 1 - prefix.len);
    @memcpy(msg[0..prefix.len], prefix);
    @memcpy(msg[prefix.len..][0..n], name[0..n]);
    msg[prefix.len + n] = 0;
    c.jsrt_panic(&msg);
}

/// A worker must register before its first Stator allocation and leave after publishing its result.
pub fn enterThread() void {
    impl.enterThread();
}
pub fn leaveThread() void {
    jsrt_gc_safepoint();
    impl.leaveThread();
}

export fn jsrt_gc_collect() void {
    impl.collect();
}
