//! `statorc-zig` entry point.

const std = @import("std");
const stator_ts = @import("stator_ts");
const core = @import("stator_core");

const commands = core.passes.commands;

pub const panic = std.debug.FullPanic(core.crash.panic);

pub fn main(init: std.process.Init) !void {
    _ = stator_ts;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    const command: []const u8 = if (args.len > 1) args[1] else "";
    const rest = if (args.len > 2) args[2..] else args[0..0];
    if (std.mem.eql(u8, command, "verify")) std.process.exit(commands.runVerify(init.io, arena, rest));
    if (std.mem.eql(u8, command, "passes")) std.process.exit(commands.runPasses(init.io, arena, rest));
    if (std.mem.eql(u8, command, "emit-c")) std.process.exit(core.codegen.commands.runEmitC(init.io, arena, rest));
    std.process.exit(core.driver.run(init));
}
