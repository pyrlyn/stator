//! Stator compiler core in Zig (docs/zig-core.md). Front end: stator-ts (parser, binder, checker).

pub const support = @import("support/root.zig");
pub const gate = @import("frontend/gate.zig");
pub const program = @import("frontend/program.zig");
pub const crash = @import("cli/crash.zig");
pub const driver = @import("cli/driver.zig");
pub const hir = @import("hir/root.zig");
pub const passes = @import("passes/root.zig");
pub const codegen = @import("codegen/root.zig");
pub const lower = @import("lower/root.zig");

test {
    _ = @import("frontend/std.zig");
    _ = @import("frontend/node.zig");
    _ = @import("frontend/location.zig");
    _ = @import("frontend/program.zig");
    _ = @import("cli/root.zig");
    _ = gate;
    _ = program;
    _ = support;
    _ = hir;
    _ = passes;
    _ = codegen;
}
