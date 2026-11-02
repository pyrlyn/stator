//! The HIR: the vocabulary between lowering, the passes and the emitter.

pub const types = @import("types.zig");
pub const nodes = @import("nodes.zig");
pub const json = @import("json.zig");

test {
    _ = types;
    _ = nodes;
    _ = json;
    _ = @import("keyof.zig");
}
