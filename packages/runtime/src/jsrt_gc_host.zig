//! The `host` module pyrlyn/gc's collectors import: the symbols `kxgc.h` says the runtime provides
//! (plan-notes 401). pyrlyn's own `src/host.zig` is a stand-in for its tests; Stator builds the
//! collector against this file instead, so a collector failure reads as a runtime panic.

const std = @import("std");
const builtin = @import("builtin");
const c = @import("jsrt_c");

/// Non-zero forbids a collection from starting inside `rt_cc_possible_root`. Stator keeps it set
/// outside its own collection (jsrt_gc.zig): a cycle held only by a stack slot is live, and only
/// the collection that pins the roots first may run trial deletion.
pub export var rt_rel_draining: c_int = 1;
/// KotlinX's collection-owner protocol for the epoch collector; Stator links perceus, which never
/// reads it.
pub export var rt_relo_owner: c_int = 0;
/// Set by trial deletion around `trav` calls. Stator's `trav` visits the same references in every
/// mode, so it only has to exist.
pub export threadlocal var rt_trav_mode: c_int = 0;

extern "c" fn clock_gettime_nsec_np(clock_id: std.c.clockid_t) u64;

pub export fn rt_nanos() i64 {
    if (comptime builtin.os.tag == .macos) {
        return @intCast(clock_gettime_nsec_np(.UPTIME_RAW));
    } else {
        var ts: std.c.timespec = .{ .sec = 0, .nsec = 0 };
        _ = std.c.clock_gettime(.MONOTONIC, &ts);
        return @as(i64, ts.sec) * 1_000_000_000 + @as(i64, ts.nsec);
    }
}

pub export fn rt_panic(msg: [*:0]const u8) noreturn {
    c.jsrt_panic(msg);
}

/// Pause percentiles are a KotlinX statistic; the runtime keeps only the total in `rt_gc_stats`.
pub export fn rt_gc_note_pause(pause_ns: i64) void {
    _ = pause_ns;
}

pub fn oom() noreturn {
    c.jsrt_panic("out of memory: collector");
}

pub fn malloc(n: usize) *anyopaque {
    return std.c.malloc(if (n == 0) 1 else n) orelse oom();
}

pub fn calloc(n: usize) *anyopaque {
    return std.c.calloc(1, if (n == 0) 1 else n) orelse oom();
}

pub fn realloc(p: ?*anyopaque, n: usize) *anyopaque {
    return std.c.realloc(p, if (n == 0) 1 else n) orelse oom();
}

pub fn free(p: ?*anyopaque) void {
    std.c.free(p);
}
