//! Stator compiler core in Zig (docs/zig-core.md). Phase 1: the lexer.

pub const lexer = @import("lexer.zig");

test {
    _ = lexer;
    _ = @import("golden_test.zig");
}
