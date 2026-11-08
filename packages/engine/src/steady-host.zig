//! Benchmark-only monotonic clock. Production scripts get no extra global or CLI flag.
const std = @import("std");
const interp = @import("stator_interp");
const c = interp.rt.c;

extern "c" fn rt_nanos() i64;

fn now(_: u32, _: [*c]const interp.rt.Value, _: [*c]c.JSRTEnv) callconv(.c) interp.rt.Value {
    return interp.rt.number(@as(f64, @floatFromInt(rt_nanos())) / 1e6);
}

pub fn main(init: std.process.Init) !u8 {
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    if (args.len != 2 or !interp.jit.available) return error.BenchmarkHostUnavailable;
    const src = try std.Io.Dir.cwd().readFileAlloc(init.io, args[1], a, .unlimited);
    c.jsrt_init();
    const global = interp.builtins.global();
    interp.vm.defineOwn(global, "__benchNow", c.jsrt_closure_new(&now, 0, "__benchNow", null, true));
    switch (interp.engine.run(a, args[1], src, .js, .jit)) {
        .ok => return 0,
        .uncaught => {
            const exception = c.jsrt_take_exception();
            c.jsrt_eprint(c.jsrt_to_string(exception));
            return 1;
        },
        else => return error.BenchmarkScriptRejected,
    }
}
