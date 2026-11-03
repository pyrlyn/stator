//! `ffi-gen` (`packages/compiler/src/ffi-gen/`, plan.md §10 Task 7.3): C header to Stator `.d.ts`.
//! `command.zig` and `hand.zig` need the stator-ts parser, so `src/cli/driver.zig` imports them
//! directly and this root stays testable alone.
const std = @import("std");
pub const abi = @import("abi.zig");
pub const ast = @import("ast.zig");
pub const diff = @import("diff.zig");
pub const emit = @import("emit.zig");
pub const jsdoc = @import("jsdoc.zig");
pub const model = @import("model.zig");
pub const text = @import("text.zig");

test {
    std.testing.refAllDecls(@This());
    _ = @import("tests.zig");
}
