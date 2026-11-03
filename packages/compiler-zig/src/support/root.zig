//! Shared support: diagnostics and small utilities. User-facing failures are diagnostics, never
//! panics.
const std = @import("std");
pub const diagnostics = @import("diagnostics.zig");
pub const features = @import("features.zig");
pub const phases = @import("phases.zig");
pub const package_root = @import("package_root.zig");
pub const js_text = @import("js_text.zig");
pub const node_field = @import("node_field.zig");
pub const ast_walk = @import("ast_walk.zig");
pub const names = @import("names.zig");

test {
    std.testing.refAllDecls(@This());
}
