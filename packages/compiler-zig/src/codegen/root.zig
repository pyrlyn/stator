//! The C emitter: post-pass HIR in, one translation unit out, byte-identical to
//! `packages/compiler/src/codegen/`.

const std = @import("std");
const nodes = @import("../hir/nodes.zig");
const types = @import("../hir/types.zig");

pub const commands = @import("commands.zig");
pub const emitter = @import("emitter.zig");
pub const helpers = @import("helpers.zig");
pub const literals = @import("literals.zig");
pub const module = @import("module.zig");
pub const tables = @import("tables.zig");

pub const Emitter = emitter.Emitter;
pub const LibraryEmit = module.LibraryEmit;

pub const Output = union(enum) {
    source: []const u8,
    /// A compiler bug the walk surfaced.
    internal: []const u8,
};

pub fn emitModule(arena: std.mem.Allocator, hir: *const nodes.Module, library: ?LibraryEmit) std.mem.Allocator.Error!Output {
    var e: Emitter = try .init(arena);
    const source = module.emit(&e, hir, library) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.InternalError => return .{ .internal = e.failure },
    };
    return .{ .source = source };
}

test "an empty module is the runtime prologue and nothing else" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const module_type: types.HType = .undefined;
    const hir: nodes.Module = .{
        .type = &module_type,
        .span = .{ .start = 0, .length = 0, .line = 1 },
        .file_name = "/a.ts",
        .statements = &.{},
        .is_async = false,
        .env_vars = &.{},
    };
    const output = try emitModule(arena.allocator(), &hir, null);
    try std.testing.expectEqualStrings(
        \\#include "jsrt_value.h"
        \\
        \\JSRT_GLOBALS(1);
        \\
        \\int main(int argc, char **argv) {
        \\#line 1 "/a.ts"
        \\  jsrt_init();
        \\#line 1 "/a.ts"
        \\  jsrt_process_args(argc, argv);
        \\#line 1 "/a.ts"
        \\  JSRT_GLOBALS_ENTER(1);
        \\#line 1 "/a.ts"
        \\  return (int)jsrt_process_exit_code();
        \\}
        \\
    , output.source);
}

test {
    std.testing.refAllDecls(@This());
    _ = literals;
    _ = tables;
    _ = helpers;
    _ = @import("statements.zig");
}
