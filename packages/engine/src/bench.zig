//! `zig build bench -- [--runs=N] [--mode=jit|interp] <file.js>…` (docs/ENGINE.md §4): each
//! program run by the engine in this process, best of N, so the time is the engine's alone —
//! no process start, no runtime start-up. The programs' own output goes to /dev/null. The
//! programs must survive running twice in one realm: packages/tests/engine/bench/ wraps each in
//! `function main()`, since a second top-level `let` or `const` of one name is a SyntaxError.

const std = @import("std");
const Io = std.Io;
const interp = @import("stator_interp");
const engine = interp.engine;

pub fn main(init: std.process.Init) !u8 {
    const io = init.io;
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    var runs: usize = 5;
    var mode: engine.Mode = .jit;
    var files: std.ArrayList([]const u8) = .empty;
    for (args[1..]) |arg| {
        if (std.mem.startsWith(u8, arg, "--runs=")) {
            runs = std.fmt.parseInt(usize, arg["--runs=".len..], 10) catch return usage(io);
            if (runs == 0) return usage(io);
        } else if (std.mem.startsWith(u8, arg, "--mode=")) {
            mode = std.meta.stringToEnum(engine.Mode, arg["--mode=".len..]) orelse return usage(io);
        } else if (std.mem.startsWith(u8, arg, "-")) {
            return usage(io);
        } else try files.append(a, arg);
    }
    if (files.items.len == 0) return usage(io);

    var out: [4096]u8 = undefined;
    var w = Io.File.stdout().writerStreaming(io, &out);
    try w.interface.print("| program | engine {s} ms (best of {d}, in-process) | templates compiled |\n|---|---:|---:|\n", .{ @tagName(mode), runs });
    for (files.items) |path| {
        const src = try Io.Dir.cwd().readFileAlloc(io, path, a, .unlimited);
        const lang = engine.languageOf(path) orelse return usage(io);
        var best: u64 = std.math.maxInt(u64);
        const compiled = interp.jit.compiled;
        for (0..runs) |_| {
            var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer arena.deinit();
            const quiet = try Quiet.start();
            const t0 = now();
            const outcome = engine.run(arena.allocator(), path, src, lang, mode);
            const ns = now() - t0;
            quiet.stop();
            if (outcome != .ok) {
                try w.interface.flush();
                std.debug.print("{s}: {s}\n", .{ path, @tagName(outcome) });
                return 1;
            }
            best = @min(best, ns);
        }
        const ms = @as(f64, @floatFromInt(best)) / std.time.ns_per_ms;
        try w.interface.print("| {s} | {d:.1} | {d} |\n", .{ std.fs.path.basename(path), ms, (interp.jit.compiled - compiled) / runs });
    }
    try w.interface.flush();
    return 0;
}

fn now() u64 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(.MONOTONIC, &ts);
    return @as(u64, @intCast(ts.sec)) * std.time.ns_per_s + @as(u64, @intCast(ts.nsec));
}

extern "c" fn fflush(stream: ?*anyopaque) c_int;

/// Standard output pointed at /dev/null while a program runs, restored after.
const Quiet = struct {
    saved: c_int,

    fn start() !Quiet {
        const saved = std.c.dup(1);
        const null_fd = std.c.open("/dev/null", .{ .ACCMODE = .WRONLY });
        if (saved < 0 or null_fd < 0) return error.CannotSilenceStdout;
        _ = std.c.dup2(null_fd, 1);
        _ = std.c.close(null_fd);
        return .{ .saved = saved };
    }

    fn stop(q: Quiet) void {
        // The runtime prints through stdio: its buffer must drain into /dev/null, not after.
        _ = fflush(null);
        _ = std.c.dup2(q.saved, 1);
        _ = std.c.close(q.saved);
    }
};

fn usage(io: Io) u8 {
    Io.File.stderr().writeStreamingAll(io, "usage: bench [--runs=N] [--mode=jit|interp] <file.js>…\n") catch {};
    return 2;
}
