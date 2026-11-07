//! Test262's `test/language/` run by the interpreter (plan T14.2). Each test runs in each mode
//! its flags ask for (common.zig), in a child process of its own: a fresh realm every time, and a
//! crash or a hang (`timeout_s`) costs one test, not the run. The harness files go in front of the
//! test's source — `assert.js`, `sta.js`, `doneprintHandle.js` for `async`, then its `includes` —
//! except under `raw`. A test passes when it completes, or when it throws the error its `negative`
//! metadata names; an `async` test passes when it prints `Test262:AsyncTestComplete` once the
//! microtask queue drains. A construct the interpreter does not run yet fails the test and is
//! counted apart, by construct. Pass counts per directory are ratcheted against
//! `test262-exec.json`; `--update` records them. The command line is common.zig's. Unix only.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const interp = @import("stator_interp");
const rt = interp.rt;
const c = rt.c;
const common = @import("common.zig");

const timeout_s = 10;
/// What a child may print before the rest is dropped.
const output_cap = 16 * 1024;

const exit_pass = 0;
const exit_fail = 1;
const exit_unsupported = 3;

extern "c" fn fork() c_int;

// ---------------------------------------------------------------------- the child

/// The name of the thrown value's constructor, or "" when it has none.
fn errorName(e: rt.Value, buf: []u8) []const u8 {
    if (!rt.isObjectLike(e)) return "";
    const ctor = interp.vm.getProp(e, "constructor", null);
    if (rt.pending()) {
        _ = c.jsrt_take_exception();
        return "";
    }
    return text(interp.vm.getProp(ctor, "name", null), buf);
}

fn text(v: rt.Value, buf: []u8) []const u8 {
    const s = c.jsrt_to_string(v);
    if (rt.pending()) {
        _ = c.jsrt_take_exception();
        return "<unprintable>";
    }
    return rt.copyText(s, buf);
}

fn say(comptime fmt: []const u8, args: anytype) void {
    var buf: [1024]u8 = undefined;
    const line = std.fmt.bufPrint(&buf, fmt ++ "\n", args) catch return;
    _ = std.c.write(1, line.ptr, line.len);
}

/// Runs one test in this (child) process and answers its exit code.
fn child(src: []const u8, m: common.Meta) u8 {
    c.jsrt_init();
    const out = interp.interp.runScript(src, false);
    switch (out) {
        .unsupported => |u| {
            // An early error the parser leaves to the compiler is not a construct it lacks.
            if (m.negativeParse()) {
                say("compiled ({s} unsupported), expected a parse-time {s}", .{ u.what, m.negative_type });
                return exit_fail;
            }
            say("UNSUPPORTED {s}", .{u.what});
            return exit_unsupported;
        },
        .value => {},
    }
    if (!rt.pending() and m.is_async) c.jsrt_run_microtasks();
    if (!rt.pending()) {
        if (m.negative_phase.len != 0) {
            say("completed, expected a {s} {s}", .{ m.negative_phase, m.negative_type });
            return exit_fail;
        }
        return exit_pass;
    }
    const e = c.jsrt_take_exception();
    var name_buf: [64]u8 = undefined;
    var msg_buf: [512]u8 = undefined;
    const name = errorName(e, &name_buf);
    if (m.negative_phase.len != 0 and std.mem.eql(u8, name, m.negative_type)) return exit_pass;
    say("threw {s}", .{text(e, &msg_buf)});
    return exit_fail;
}

// ---------------------------------------------------------------------- the pool

const Pending = struct {
    path: []const u8,
    modes_left: u8,
    failed: bool = false,
    unsupported: bool = false,
};

const Slot = struct {
    pid: c_int,
    fd: c_int,
    test_index: usize,
    mode: common.Mode,
    is_async: bool,
    out: std.ArrayList(u8) = .empty,
};

const Runner = struct {
    a: Allocator,
    gpa: Allocator,
    io: Io,
    o: common.Options,
    tally: common.Tally,
    harness: std.StringHashMapUnmanaged([]const u8) = .empty,
    tests: std.ArrayList(Pending) = .empty,
    slots: std.ArrayList(Slot) = .empty,
    unsupported: std.StringArrayHashMapUnmanaged(u32) = .empty,
    unsupported_tests: u32 = 0,
    timeouts: u32 = 0,
    crashes: u32 = 0,

    fn harnessFile(r: *Runner, name: []const u8) ![]const u8 {
        if (r.harness.get(name)) |bytes| return bytes;
        const path = try std.fmt.allocPrint(r.a, "{s}/harness/{s}", .{ r.o.corpus, name });
        const bytes = try Io.Dir.cwd().readFileAlloc(r.io, path, r.a, .unlimited);
        try r.harness.put(r.a, try r.a.dupe(u8, name), bytes);
        return bytes;
    }

    /// The script a mode runs: the harness, then the test. Strict mode is a directive in front of
    /// both, as INTERPRETING.md says, so the parser's strict-mode early errors apply.
    fn source(r: *Runner, src: []const u8, m: common.Meta, mode: common.Mode) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        if (mode == .strict) try out.appendSlice(r.gpa, "\"use strict\";\n");
        if (!m.raw) {
            try out.appendSlice(r.gpa, try r.harnessFile("assert.js"));
            try out.appendSlice(r.gpa, try r.harnessFile("sta.js"));
            if (m.is_async) try out.appendSlice(r.gpa, try r.harnessFile("doneprintHandle.js"));
            for (m.includes()) |inc| try out.appendSlice(r.gpa, try r.harnessFile(inc));
        }
        try out.appendSlice(r.gpa, src);
        return out.toOwnedSlice(r.gpa);
    }

    fn start(r: *Runner, test_index: usize, mode: common.Mode, src: []const u8, m: common.Meta) !void {
        const script = try r.source(src, m, mode);
        defer r.gpa.free(script);
        var fds: [2]c_int = undefined;
        if (std.c.pipe(&fds) != 0) return error.PipeFailed;
        const pid = fork();
        if (pid < 0) return error.ForkFailed;
        if (pid == 0) {
            _ = std.c.close(fds[0]);
            _ = std.c.dup2(fds[1], 1);
            _ = std.c.dup2(fds[1], 2);
            _ = std.c.alarm(timeout_s);
            std.c._exit(child(script, m));
        }
        _ = std.c.close(fds[1]);
        try r.slots.append(r.a, .{ .pid = pid, .fd = fds[0], .test_index = test_index, .mode = mode, .is_async = m.is_async });
    }

    /// Reads what the children wrote, reaps the ones that finished.
    fn pump(r: *Runner) !void {
        var polls: std.ArrayList(std.c.pollfd) = .empty;
        defer polls.deinit(r.gpa);
        for (r.slots.items) |s| try polls.append(r.gpa, .{ .fd = s.fd, .events = std.c.POLL.IN, .revents = 0 });
        if (std.c.poll(polls.items.ptr, @intCast(polls.items.len), -1) < 0) return;
        var i: usize = polls.items.len;
        while (i > 0) {
            i -= 1;
            if (polls.items[i].revents == 0) continue;
            const s = &r.slots.items[i];
            var buf: [4096]u8 = undefined;
            const n = std.c.read(s.fd, &buf, buf.len);
            if (n > 0) {
                const keep = @min(@as(usize, @intCast(n)), output_cap -| s.out.items.len);
                try s.out.appendSlice(r.gpa, buf[0..keep]);
                continue;
            }
            _ = std.c.close(s.fd);
            var status: c_int = 0;
            _ = std.c.waitpid(s.pid, &status, 0);
            try r.reap(s.*, @bitCast(status));
            s.out.deinit(r.gpa);
            _ = r.slots.swapRemove(i);
        }
    }

    fn reap(r: *Runner, s: Slot, status: u32) !void {
        const p = &r.tests.items[s.test_index];
        const output = std.mem.trimEnd(u8, s.out.items, "\n");
        var why: []const u8 = output;
        var ok = false;
        if (std.c.W.IFEXITED(status)) {
            switch (std.c.W.EXITSTATUS(status)) {
                exit_pass => {
                    ok = !s.is_async or std.mem.indexOf(u8, output, "Test262:AsyncTestComplete") != null;
                    if (!ok) why = if (output.len == 0) "async test never called $DONE" else output;
                },
                exit_unsupported => {
                    p.unsupported = true;
                    const marker = "UNSUPPORTED ";
                    const at = std.mem.lastIndexOf(u8, output, marker);
                    const key = if (at) |i| std.mem.trim(u8, output[i + marker.len ..], " ") else output;
                    const slot = try r.unsupported.getOrPut(r.a, key);
                    if (!slot.found_existing) {
                        slot.key_ptr.* = try r.a.dupe(u8, key);
                        slot.value_ptr.* = 0;
                    }
                    slot.value_ptr.* += 1;
                },
                else => {},
            }
        } else {
            const sig = std.c.W.TERMSIG(status);
            if (sig == .ALRM) {
                r.timeouts += 1;
                why = "timed out";
            } else {
                r.crashes += 1;
                why = try std.fmt.allocPrint(r.a, "killed by signal {t}: {s}", .{ sig, output });
            }
        }
        if (!ok and !p.failed) {
            p.failed = true;
            if (r.o.failures and !p.unsupported) try r.tally.failures.print(r.a, "FAIL {s} [{t}]: {s}\n", .{ p.path, s.mode, why });
        }
        p.modes_left -= 1;
        if (p.modes_left == 0) {
            try r.tally.record(p.path, !p.failed);
            if (p.unsupported) r.unsupported_tests += 1;
        }
    }
};

pub fn main(init: std.process.Init) !u8 {
    const a = init.arena.allocator();
    const io = init.io;
    const o = try common.parseArgs(init, "test262-exec") orelse return 2;
    var corpus = try common.Corpus.open(o, init.gpa, io) orelse return 2;
    defer corpus.close(io);

    var r: Runner = .{ .a = a, .gpa = init.gpa, .io = io, .o = o, .tally = .{ .a = a } };
    const jobs = std.Thread.getCpuCount() catch 4;
    var modules: u32 = 0;
    while (try corpus.next(io)) |e| {
        const m = common.readMeta(e.src);
        const index = r.tests.items.len;
        const ms = common.modes(m);
        try r.tests.append(a, .{ .path = try a.dupe(u8, e.path), .modes_left = @intCast(ms.len) });
        if (m.module) {
            // Modules are T14.3's: no child runs one yet.
            modules += 1;
            try r.tally.record(e.path, false);
            continue;
        }
        for (ms) |mode| {
            while (r.slots.items.len >= jobs) try r.pump();
            try r.start(index, mode, e.src, m);
        }
    }
    while (r.slots.items.len > 0) try r.pump();

    var summary: std.ArrayList(u8) = .empty;
    try summary.print(a, "not run: {d} module tests; unsupported constructs in {d} tests; {d} timeouts; {d} crashes\n", .{ modules, r.unsupported_tests, r.timeouts, r.crashes });
    const Ctx = struct {
        counts: []const u32,
        pub fn lessThan(ctx: @This(), x: usize, y: usize) bool {
            return ctx.counts[x] > ctx.counts[y];
        }
    };
    r.unsupported.sort(Ctx{ .counts = r.unsupported.values() });
    for (r.unsupported.keys(), r.unsupported.values()) |k, v| try summary.print(a, "  {d:>6}  {s}\n", .{ v, k });
    return common.finish(a, io, o, &r.tally, "test262-exec.json", summary.items);
}

test {
    _ = common;
}
