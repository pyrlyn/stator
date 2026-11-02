//! HIR passes. Monomorphization and boundary-check insertion are not here: each needs a fact that
//! only the lowering still has (plan-notes 73, 74).

const std = @import("std");
const Allocator = std.mem.Allocator;
const nodes = @import("../hir/nodes.zig");

pub const commands = @import("commands.zig");
pub const constfold = @import("constfold.zig");
pub const dce = @import("dce.zig");
pub const @"inline" = @import("inline.zig");
pub const jsvalue = @import("jsvalue.zig");
pub const rewrite = @import("rewrite.zig");

pub const Error = rewrite.Error;
pub const Rewriter = rewrite.Rewriter;

/// Every pass, once, in the one order where each feeds the next: inlining exposes constants,
/// folding decides branches, and eliminating those makes functions unreachable. `roots` are entry
/// points a C caller reaches without any statement naming them.
pub fn optimize(arena: Allocator, module: *const nodes.Module, roots: []const []const u8) Error!*const nodes.Module {
    const inlined = try @"inline".inlineCalls(arena, module);
    const folded = try constfold.constFold(arena, inlined);
    return dce.eliminateDeadCode(arena, folded, roots);
}

test {
    _ = @import("tests.zig");
    std.testing.refAllDecls(@This());
}
