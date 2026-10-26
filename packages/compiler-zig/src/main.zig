//! `statorc-zig tokens <file>`: prints the token stream of a TypeScript file in the golden-file
//! form (`Kind<TAB>start<TAB>end`). A development aid while the Zig core grows (docs/zig-core.md).

const std = @import("std");
const core = @import("stator_core");

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len != 3 or !std.mem.eql(u8, args[1], "tokens")) {
        std.debug.print("usage: statorc-zig tokens <file.ts>\n", .{});
        std.process.exit(2);
    }
    const source = try std.Io.Dir.cwd().readFileAlloc(io, args[2], gpa, .limited(64 << 20));
    defer gpa.free(source);
    var buf: [64 * 1024]u8 = undefined;
    var stdout = std.Io.File.stdout().writer(io, &buf);
    try core.lexer.dump(source, &stdout.interface);
    try stdout.interface.flush();
}
