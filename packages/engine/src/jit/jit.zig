//! The engine's baseline JIT (docs/ENGINE.md §3): in `jit` mode a template's first call compiles
//! it through pyrlyn/jit for the host (AArch64 or x86-64), and every call after runs that code.
//! A template the JIT does not take — or a host it has no backend for — runs in the interpreter.

const std = @import("std");
const builtin = @import("builtin");
const pj = @import("pyrlyn_jit");
const rt = @import("../rt.zig");
const c = rt.c;
const bc = @import("../bytecode.zig");
const analyze = @import("analyze.zig");
const lower = @import("lower.zig");
const helpers = @import("helpers.zig");
const Value = rt.Value;
const Template = bc.Template;

pub const Mode = enum { interp, jit };

/// The process's execution mode; `interp` unless the engine's entry (src/engine.zig) chose `jit`.
pub var mode: Mode = .interp;

/// Templates compiled so far, for the tests and `--stats`.
pub var compiled: usize = 0;

const host = switch (builtin.cpu.arch) {
    .aarch64 => if (pj.build_options.aarch64) pj.aarch64_compiler else void,
    // pyrlyn/jit's x86-64 compiler targets the SysV ABI; Windows stays interpreted.
    .x86_64 => if (pj.build_options.x86_64 and builtin.os.tag != .windows) pj.x86_64_compiler else void,
    else => void,
};

/// Whether this build has a backend for the host.
pub const available = host != void;

pub const Native = *const fn (*helpers.Ctx) callconv(.c) Value;

/// The native code for `t`, compiling it on its first call; null to interpret it.
pub fn codeFor(t: *Template) ?Native {
    if (mode != .jit or !available) return null;
    switch (t.jit.state) {
        .compiled => return @ptrCast(@alignCast(t.jit.code.?)),
        .rejected => return null,
        .untried => {},
    }
    const native = compile(t) catch |e| blk: {
        trace(t, "rejected: {s}", .{@errorName(e)});
        break :blk null;
    };
    if (native) |n| {
        t.jit = .{ .state = .compiled, .code = @ptrCast(n) };
        compiled += 1;
    } else t.jit.state = .rejected;
    return native;
}

/// Runs `native` on the frame `vm.exec` set up for it: the window is published as a GC root and
/// its call values are in place.
pub fn enter(native: Native, t: *Template, fe: ?*c.JSRTEnv, w: [*]Value, argv: []const Value, frame: *c.JSRTFrame) Value {
    var cx: helpers.Ctx = .{ .w = w, .argv = argv.ptr, .argc = argv.len, .frame = frame, .t = t, .fe = fe };
    return native(&cx);
}

fn compile(t: *Template) !?Native {
    if (host == void) return null;
    const gpa = std.heap.c_allocator;
    const plan = switch (try analyze.analyze(gpa, t)) {
        .plan => |p| p,
        .reject => |why| {
            switch (why) {
                .shape => |s| trace(t, "rejected: {s}", .{s}),
                .op => |o| trace(t, "rejected: opcode {s}", .{@tagName(o)}),
                .depth => |pc| trace(t, "rejected: depths disagree at {d}", .{pc}),
            }
            return null;
        },
    };
    defer plan.deinit(gpa);
    var f = pj.ir.Func.init(gpa);
    defer f.deinit();
    try lower.lower(&f, t, plan);
    var cb = pj.CodeBuffer.init(gpa);
    defer cb.deinit();
    _ = try host.compile(gpa, &f, &cb, .{});
    // Templates are immortal, so their code is never released.
    const fun = try pj.JitRuntime.add(&cb);
    trace(t, "compiled: {d} instructions, {d} bytes", .{ plan.insns.len, cb.code().len });
    return fun.ptr(Native);
}

var trace_on: ?bool = null;

/// `STATOR_JIT_TRACE=1` prints what the JIT did with each template, for tuning and benchmarks.
fn trace(t: *const Template, comptime fmt: []const u8, args: anytype) void {
    const on = trace_on orelse blk: {
        const v = std.c.getenv("STATOR_JIT_TRACE");
        const b = v != null and v.?[0] != 0 and v.?[0] != '0';
        trace_on = b;
        break :blk b;
    };
    if (!on) return;
    std.debug.print("jit: {s}: " ++ fmt ++ "\n", .{std.mem.span(t.name)} ++ args);
}

test {
    _ = analyze;
}
