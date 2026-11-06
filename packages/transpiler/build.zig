const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const coroutines = b.dependency("coroutines", .{ .target = target, .optimize = optimize }).module("coroutines");
    const jstext = b.dependency("jstext", .{ .target = target, .optimize = optimize }).module("jstext");
    mod.addImport("coroutines", coroutines);
    mod.addImport("jstext", jstext);

    const lib = b.addModule("stator_ts", .{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });
    lib.addImport("coroutines", coroutines);
    lib.addImport("jstext", jstext);

    const exe = b.addExecutable(.{ .name = "stator-ts", .root_module = mod });
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    run.addPassthruArgs();
    b.step("run", "Run stator-ts").dependOn(&run.step);

    const tests = b.addTest(.{ .root_module = mod });
    b.step("test", "Run unit tests").dependOn(&b.addRunArtifact(tests).step);
}
