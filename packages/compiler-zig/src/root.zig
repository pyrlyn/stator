//! Stator compiler core in Zig (docs/zig-core.md). Front end: Oxc via `oxc-bridge` (C ABI).

pub const oxc = @import("oxc.zig");
pub const gate = @import("gate.zig");

test {
    _ = oxc;
    _ = gate;
}
