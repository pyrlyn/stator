//! Which runtime archive a compilation links against, and so which builtins the gate may accept.
//! `STATOR_RUNTIME` selects the archive and the gate reads the same value: one variable is what
//! keeps a program from being accepted against a surface its archive does not carry.
const std = @import("std");

pub const RuntimeFlavor = enum { default, asan, intl };

/// Takes the value rather than reading the environment: Zig's environment arrives through
/// `process.Init`, and a build pins one flavor for the whole compile anyway.
pub fn runtimeFlavor(requested: ?[]const u8) RuntimeFlavor {
    const r = requested orelse return .default;
    if (std.mem.eql(u8, r, "asan")) return .asan;
    if (std.mem.eql(u8, r, "intl")) return .intl;
    return .default;
}

/// ICU is a feature build, off by default: ~10 MB of CLDR data, and the default runtime must stay
/// byte-identical whether or not the host has ICU installed.
pub fn intlEnabled(flavor: RuntimeFlavor) bool {
    return flavor == .intl;
}

test "an unknown flavor is the default" {
    try std.testing.expectEqual(RuntimeFlavor.default, runtimeFlavor("tsan"));
    try std.testing.expectEqual(RuntimeFlavor.default, runtimeFlavor(null));
    try std.testing.expect(intlEnabled(runtimeFlavor("intl")));
}
