//! `std/env` backings (docs/STD.md §5): the process environment through libc, because the
//! environment is libc's — `setenv` must be visible to every C caller in the process, which a
//! Zig-side copy would not be — plus the working directory through Zig's std.

const std = @import("std");
const root = @import("jsrt_std.zig");

extern "c" fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;
extern "c" fn unsetenv(name: [*:0]const u8) c_int;

/// POSIX refuses an empty name or one containing `=` with EINVAL; checked here so the answer does
/// not depend on which libc is underneath (glibc and Darwin agree, but neither is the contract).
fn validName(name: [*:0]const u8) bool {
    const n = std.mem.span(name);
    return n.len > 0 and std.mem.indexOfScalar(u8, n, '=') == null;
}

export fn jsrt_std_env_has(name: [*:0]const u8) f64 {
    return if (std.c.getenv(name) != null) 1 else 0;
}

/// The value, or "" when unset: the TS wrapper asks `has` first, so "" here is only ever an empty
/// value. `getenv`'s pointer stays valid until the next `setenv`/`unsetenv`, which cannot run
/// before the emitter copies it.
export fn jsrt_std_env_get(name: [*:0]const u8) [*:0]const u8 {
    return std.c.getenv(name) orelse "";
}

export fn jsrt_std_env_set(name: [*:0]const u8, value: [*:0]const u8) f64 {
    if (!validName(name)) return root.fail("EINVAL");
    return if (setenv(name, value, 1) == 0) 0 else root.fail("ENOMEM");
}

export fn jsrt_std_env_unset(name: [*:0]const u8) f64 {
    if (!validName(name)) return root.fail("EINVAL");
    return if (unsetenv(name) == 0) 0 else root.fail("EINVAL");
}

// POSIX `environ`: the names `std/env.names` walks. Windows CI does not build this archive
// (docs/STD.md §4). A `setenv` is visible here the moment it returns, because this is libc's
// own vector — the same one `getenv` reads.
extern "c" var environ: [*:null]?[*:0]u8;

export fn jsrt_std_env_count() f64 {
    var n: usize = 0;
    while (environ[n] != null) : (n += 1) {}
    return @floatFromInt(n);
}

/// Name of variable `index` (text before the first `=`), parked for `jsrtStdResult`. Past the
/// end is EINVAL. The value is never parked: a value may be a secret (docs/STD.md §5).
export fn jsrt_std_env_name(index: f64) f64 {
    const wanted: usize = @intCast(root.intIn(index, 0, std.math.maxInt(c_int)) orelse return root.fail("EINVAL"));
    var n: usize = 0;
    while (n < wanted and environ[n] != null) : (n += 1) {}
    const entry = environ[n] orelse return root.fail("EINVAL");
    const text = std.mem.span(entry);
    const end = std.mem.indexOfScalar(u8, text, '=') orelse text.len;
    root.setResult(root.allocator.dupeZ(u8, text[0..end]) catch |err| return root.failWith(err));
    return 0;
}

export fn jsrt_std_env_cwd() f64 {
    const path = std.process.currentPathAlloc(root.io(), root.allocator) catch |err| return root.failWith(err);
    root.setResult(path);
    return 0;
}
