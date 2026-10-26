const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Rust front end (oxc-bridge): built by cargo, linked as a static library.
    const cargo = b.addSystemCommand(&.{ "cargo", "build", "--release", "--quiet", "--manifest-path" });
    cargo.addFileArg(b.path("oxc-bridge/Cargo.toml"));
    cargo.has_side_effects = true; // cargo does its own up-to-date check
    const lib_dir = b.path("oxc-bridge/target/release");

    const core = b.addModule("stator_core", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    core.addLibraryPath(lib_dir);
    core.linkSystemLibrary("stator_oxc_bridge", .{ .preferred_link_mode = .static, .use_pkg_config = .no });
    if (target.result.os.tag == .macos) core.linkFramework("CoreFoundation", .{});

    const exe = b.addExecutable(.{
        .name = "statorc-zig",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "stator_core", .module = core }},
        }),
    });
    exe.step.dependOn(&cargo.step);
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run statorc-zig").dependOn(&run.step);

    const tests = b.addTest(.{ .root_module = core });
    tests.step.dependOn(&cargo.step);
    b.step("test", "Run Oxc bridge tests").dependOn(&b.addRunArtifact(tests).step);
}
