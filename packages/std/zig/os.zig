//! `std/os` backings (docs/STD.md §5): what the machine and the user's account are. The answers
//! follow the pinned Node's `node:os` (the golden's oracle), because `packages/node` builds
//! `node:os` on these and must not re-derive them; each function says where the rule comes from.

const std = @import("std");
const builtin = @import("builtin");
const root = @import("jsrt_std.zig");

/// Node's `process.platform` spelling of the target OS, fixed at build time.
export fn jsrt_std_os_platform() [*:0]const u8 {
    return switch (builtin.os.tag) {
        .macos => "darwin",
        .linux => "linux",
        .freebsd => "freebsd",
        .openbsd => "openbsd",
        .netbsd => "netbsd",
        .windows => "win32",
        else => @tagName(builtin.os.tag),
    };
}

/// Node's `process.arch` spelling of the target CPU, fixed at build time.
export fn jsrt_std_os_arch() [*:0]const u8 {
    return switch (builtin.cpu.arch) {
        .aarch64 => "arm64",
        .x86_64 => "x64",
        .x86 => "ia32",
        .arm => "arm",
        .riscv64 => "riscv64",
        .powerpc64, .powerpc64le => "ppc64",
        .s390x => "s390x",
        .loongarch64 => "loong64",
        .mips => "mips",
        .mipsel => "mipsel",
        else => @tagName(builtin.cpu.arch),
    };
}

fn parkCopy(text: []const u8) f64 {
    const owned = root.allocator.dupeSentinel(u8, text, 0) catch return root.fail("ENOMEM");
    root.setResult(owned);
    return 0;
}

/// `uname(2)`'s release field: the kernel version (Darwin's, not macOS's marketing version).
export fn jsrt_std_os_release() f64 {
    return jsrt_std_os_uname(1);
}

/// One `uname(2)` field: 0 sysname (`os.type()`), 1 release (`os.release()`), 2 version
/// (`os.version()`), 3 machine (`os.machine()`). Node reads these four through libuv's
/// `uv_os_uname`, which copies the same fields.
export fn jsrt_std_os_uname(field: f64) f64 {
    const uts = std.posix.uname();
    const text: []const u8 = if (field == 0)
        std.mem.sliceTo(&uts.sysname, 0)
    else if (field == 1)
        std.mem.sliceTo(&uts.release, 0)
    else if (field == 2)
        std.mem.sliceTo(&uts.version, 0)
    else if (field == 3)
        std.mem.sliceTo(&uts.machine, 0)
    else
        return root.fail("EINVAL");
    return parkCopy(text);
}

export fn jsrt_std_os_hostname() f64 {
    var buf: [std.posix.HOST_NAME_MAX]u8 = undefined;
    const name = std.posix.gethostname(&buf) catch |err| return root.failWith(err);
    return parkCopy(name);
}

/// libuv's `uv_os_homedir`, which `os.homedir()` calls: `$HOME` whenever it is set, even to the
/// empty string, else the password database's entry for the real user id.
export fn jsrt_std_os_homedir() f64 {
    if (std.c.getenv("HOME")) |home| return parkCopy(std.mem.span(home));
    const entry = std.c.getpwuid(std.c.getuid()) orelse return root.fail("ENOENT");
    const dir = entry.dir orelse return root.fail("ENOENT");
    return parkCopy(std.mem.span(dir));
}

/// `os.tmpdir()` on POSIX: the first NON-EMPTY of `$TMPDIR`, `$TMP`, `$TEMP`, else `/tmp`, minus
/// one trailing `/` when the path is longer than `/` itself.
export fn jsrt_std_os_tmpdir() f64 {
    var dir: []const u8 = "/tmp";
    for ([_][*:0]const u8{ "TMPDIR", "TMP", "TEMP" }) |name| {
        const value = std.mem.span(std.c.getenv(name) orelse continue);
        if (value.len > 0) {
            dir = value;
            break;
        }
    }
    if (dir.len > 1 and dir[dir.len - 1] == '/') dir = dir[0 .. dir.len - 1];
    return parkCopy(dir);
}

/// The CPUs this process may run on: the affinity mask on Linux, the logical CPUs on Darwin —
/// `os.availableParallelism()`'s answer, not `os.cpus().length` (which counts every CPU the
/// kernel knows, including ones the process may not use). Like libuv's
/// `uv_available_parallelism`, a count the OS will not give is 1, never an error.
export fn jsrt_std_os_cpu_count() f64 {
    const count = std.Thread.getCpuCount() catch return 1;
    return @floatFromInt(count);
}

/// Physical memory in bytes (`hw.memsize` on Darwin, `sysinfo(2)` on Linux) — `os.totalmem()`.
/// A count cannot share the status return, so failure is `-1` after recording `EIO`.
export fn jsrt_std_os_total_memory() f64 {
    const bytes = std.process.totalSystemMemory() catch {
        _ = root.fail("EIO");
        return -1;
    };
    return @floatFromInt(bytes);
}
