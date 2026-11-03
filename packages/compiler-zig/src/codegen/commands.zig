//! The subcommand `packages/tests/zigdiff` reaches the emitter through: one post-pass HIR-JSON dump
//! in, C out, so this stage can be held to the TypeScript emitter before the lowering is ported.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const codegen = @import("root.zig");
const dumps = @import("../passes/commands.zig");
const FAILED = dumps.FAILED;
const fail = dumps.fail;

pub const USAGE =
    \\  emit-c [--library=<spec.json>] <hir.json>   print the C for a post-pass HIR dump
    \\
;

/// A library build's C surface comes from the checker, which is in front of this stage, so the
/// spec file stands in for it until the driver passes `LibraryEmit` itself.
fn readLibrary(io: Io, arena: Allocator, path: []const u8) ?codegen.LibraryEmit {
    const text = dumps.readInput(io, arena, path) orelse return null;
    return std.json.parseFromSliceLeaky(codegen.LibraryEmit, arena, text, .{}) catch |err| {
        _ = fail(io, arena, "{t} parsing {s}", .{ err, path });
        return null;
    };
}

pub fn runEmitC(io: Io, arena: Allocator, args: []const [:0]const u8) u8 {
    var library: ?codegen.LibraryEmit = null;
    var dump: ?[]const u8 = null;
    for (args) |arg| {
        if (std.mem.startsWith(u8, arg, "--library=")) {
            library = readLibrary(io, arena, arg["--library=".len..]) orelse return FAILED;
        } else if (dump == null) {
            dump = arg;
        } else {
            return fail(io, arena, "emit-c takes one dump, and {s} is a second", .{arg});
        }
    }
    const path = dump orelse return fail(io, arena, "emit-c takes one dump, and got none", .{});
    const module = dumps.load(io, arena, path) orelse return FAILED;
    const output = codegen.emitModule(arena, module, library) catch return fail(io, arena, "out of memory emitting {s}", .{path});
    switch (output) {
        .internal => |message| return fail(io, arena, "{s}: {s}", .{ path, message }),
        .source => |source| Io.File.stdout().writeStreamingAll(io, source) catch |err| return fail(io, arena, "{t} writing the C of {s}", .{ err, path }),
    }
    return 0;
}
