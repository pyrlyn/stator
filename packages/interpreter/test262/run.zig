//! Test262's `test/language/` run through the interpreter (plan T14.2): each test with the harness
//! its metadata includes, in each mode its flags ask for, as one global script in a fresh realm.
//! A negative test passes when it throws an error of the type it names; any other passes when it
//! completes. Module and async tests count as failures until the interpreter runs them. Pass
//! counts per directory are ratcheted against `test262-run.json` in the package; `--update`
//! records them. Arguments and corpus: `common.zig`.
//!
//! Each run happens in a forked child, so a runtime panic or a test that never ends costs that
//! test, not the run: the child starts the runtime itself, which leaves the parent without the
//! collector's threads a fork would not carry over.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const interp = @import("stator_interp");
const c = interp.c;
const common = @import("common.zig");

/// Seconds a test may run before it counts as hung.
const timeout = 10;

const Driver = struct {
    a: Allocator = undefined,
    io: Io = undefined,
    harness_dir: []const u8 = "",
    harness: std.StringHashMapUnmanaged([]const u8) = .empty,
    /// Shared with each child, which leaves the reason it failed here: a u32 length, then text.
    report: []align(std.heap.page_size_min) u8 = &.{},
    crashed: u32 = 0,
    hung: u32 = 0,

    pub fn setup(d: *Driver, a: Allocator, io: Io, corpus: []const u8) !void {
        d.a = a;
        d.io = io;
        d.harness_dir = try std.fs.path.join(a, &.{ corpus, "harness" });
        d.report = try std.posix.mmap(null, 1 << 16, .{ .READ = true, .WRITE = true }, .{ .TYPE = .SHARED, .ANONYMOUS = true }, -1, 0);
    }

    fn harnessFile(d: *Driver, file: []const u8) ![]const u8 {
        if (d.harness.get(file)) |text| return text;
        const path = try std.fs.path.join(d.a, &.{ d.harness_dir, file });
        const text = try Io.Dir.cwd().readFileAlloc(d.io, path, d.a, .unlimited);
        try d.harness.put(d.a, try d.a.dupe(u8, file), text);
        return text;
    }

    pub fn runTest(d: *Driver, scratch: Allocator, _: Io, m: common.Meta, mode: common.Mode, src: []const u8) !?[]const u8 {
        if (mode == .module) return "modules are not run yet";
        if (m.async) return "async tests are not run yet";
        var text: std.ArrayList(u8) = .empty;
        if (mode == .strict) try text.appendSlice(scratch, common.strict_prefix);
        if (!m.raw) {
            for ([_][]const u8{ "assert.js", "sta.js" }) |file| try text.appendSlice(scratch, try d.harnessFile(file));
            for (m.includes) |file| try text.appendSlice(scratch, try d.harnessFile(file));
        }
        try text.appendSlice(scratch, src);
        return d.isolated(scratch, m, text.items);
    }

    fn isolated(d: *Driver, scratch: Allocator, m: common.Meta, text: []const u8) !?[]const u8 {
        const pid = std.c.fork();
        if (pid < 0) return error.ForkFailed;
        if (pid == 0) {
            // A panic's message would interleave with the report; the parent names the signal.
            const null_fd = std.c.open("/dev/null", .{ .ACCMODE = .WRONLY });
            if (null_fd >= 0) _ = std.c.dup2(null_fd, 2);
            _ = std.c.alarm(timeout);
            c.jsrt_init();
            const why = judge(scratch, m, text);
            const n: u32 = @intCast(@min(why.len, d.report.len - 4));
            std.mem.writeInt(u32, d.report[0..4], n, .little);
            @memcpy(d.report[4..][0..n], why[0..n]);
            std.c._exit(if (why.len == 0) 0 else 1);
        }
        var status: c_int = 0;
        while (std.c.waitpid(pid, &status, 0) < 0) {}
        const s: u32 = @bitCast(status);
        if (std.c.W.IFEXITED(s)) {
            if (std.c.W.EXITSTATUS(s) == 0) return null;
            const n = std.mem.readInt(u32, d.report[0..4], .little);
            return try scratch.dupe(u8, d.report[4..][0..n]);
        }
        const sig = std.c.W.TERMSIG(s);
        if (sig == std.c.SIG.ALRM) {
            d.hung += 1;
            return try std.fmt.allocPrint(scratch, "ran past {d} s", .{timeout});
        }
        d.crashed += 1;
        return try std.fmt.allocPrint(scratch, "crashed with signal {d}", .{sig});
    }

    pub fn summary(d: *Driver, a: Allocator, out: *std.ArrayList(u8)) !void {
        try out.print(a, "crashed: {d}, ran past {d} s: {d}\n", .{ d.crashed, timeout, d.hung });
    }
};

/// Runs the script in the child: empty for a pass, else why it failed.
fn judge(a: Allocator, m: common.Meta, text: []const u8) []const u8 {
    _ = interp.vm.evalScript(text);
    if (!c.jsrt_pending()) {
        if (m.negative) |phase| return std.fmt.allocPrint(a, "completed, expected a {s} at {t}", .{ m.negative_type, phase }) catch "completed";
        return "";
    }
    const e = c.jsrt_take_exception();
    const name = errorName(e);
    if (m.negative != null) {
        if (std.mem.eql(u8, name, m.negative_type)) return "";
        return std.fmt.allocPrint(a, "threw {s}, expected a {s}: {s}", .{ name, m.negative_type, shown(e) }) catch "threw";
    }
    return std.fmt.allocPrint(a, "threw {s}", .{shown(e)}) catch "threw";
}

/// `e.name`, else `e.constructor.name`: Test262Error names itself only through its constructor.
fn errorName(e: c.jsrt_value) []const u8 {
    if (!c.jsrt_is_object(e)) return "";
    var v = c.jsrt_get_prop(e, key("name"), null);
    if (!c.jsrt_is(v, c.JSRT_TAG_STRING)) {
        const ctor = c.jsrt_get_prop(e, key("constructor"), null);
        v = if (c.jsrt_is_object(ctor)) c.jsrt_get_prop(ctor, key("name"), null) else c.JSRT_UNDEFINED;
    }
    if (c.jsrt_pending()) _ = c.jsrt_take_exception();
    if (!c.jsrt_is(v, c.JSRT_TAG_STRING)) return "";
    return std.mem.span(c.jsrt_string_to_cstr(v));
}

fn key(comptime name: []const u8) [*c]const u8 {
    return c.jsrt_shape_key(c.jsrt_string_from_utf8(name.ptr, name.len));
}

fn shown(e: c.jsrt_value) []const u8 {
    const s = c.jsrt_to_string(e);
    if (c.jsrt_pending()) {
        _ = c.jsrt_take_exception();
        return "<an exception that does not convert to a string>";
    }
    return std.mem.span(c.jsrt_string_to_cstr(s));
}

pub fn main(init: std.process.Init) !u8 {
    var d: Driver = .{};
    return common.main(init, "test262-run", &d);
}
