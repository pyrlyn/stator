const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const stator_ts = b.dependency("stator_ts", .{ .target = target, .optimize = optimize }).module("stator_ts");

    const core = b.addModule("stator_core", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        // Constant folding computes `**` with libc's `pow`, the one that agrees with V8 on every
        // input measured.
        .link_libc = true,
        .imports = &.{.{ .name = "stator_ts", .module = stator_ts }},
    });

    const exe = b.addExecutable(.{
        .name = "statorc-zig",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "stator_core", .module = core },
                .{ .name = "stator_ts", .module = stator_ts },
            },
        }),
    });
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    run.addPassthruArgs();
    b.step("run", "Run statorc-zig").dependOn(&run.step);

    const tests = b.addTest(.{ .root_module = core });
    b.step("test", "Run the Zig core's tests").dependOn(&b.addRunArtifact(tests).step);
}
