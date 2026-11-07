//! Exists so `zig build --fetch` can resolve build.zig.zon: the runtime itself is compiled by the
//! justfile, which reads the fetched collector from the package cache by its pinned hash.
const std = @import("std");

pub fn build(b: *std.Build) void {
    _ = b.dependency("kxgc", .{});
}
