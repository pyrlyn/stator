const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // stator-ts's `lib.zig` exports the checker's modules but not the parser, so the parser is a
    // module of its own, rooted at its file: everything it reaches is imported relative to it, and
    // nothing it reaches needs a module stator-ts's own build adds (docs/INTERPRETER.md §1).
    const stator_ts = b.dependency("stator_ts", .{ .target = target, .optimize = optimize });
    const parser = b.createModule(.{
        .root_source_file = stator_ts.path("src/parser.zig"),
        .target = target,
        .optimize = optimize,
    });

    const interp = b.addModule("stator_interp", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "parser", .module = parser }},
    });

    // The runtime links this archive; its `jsrt_*` imports resolve there (T14.3).
    const lib = b.addLibrary(.{ .name = "jsrt_interp", .root_module = over(b, interp, "src/capi.zig") });
    const install_lib = b.addInstallArtifact(lib, .{});
    b.getInstallStep().dependOn(&install_lib.step);
    b.step("lib", "Build libjsrt_interp.a").dependOn(&install_lib.step);

    const driver = b.addExecutable(.{ .name = "test262-parse", .root_module = over(b, interp, "test262/parse.zig") });
    const test_step = b.step("test", "Run the interpreter's tests");
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = interp })).step);
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = driver.root_module })).step);

    const run_driver = b.addRunArtifact(driver);
    // The package directory, from which the driver finds its baseline and the default corpus.
    run_driver.addDirectoryArg2(b.path("."), .{ .prefix = "--package=", .make_absolute = true });
    run_driver.addPassthruArgs();
    // The corpus is outside the build graph, so a cached result would skip a changed corpus.
    run_driver.has_side_effects = true;
    b.step("test262-parse", "Parse Test262's language/ tests and ratchet the pass counts").dependOn(&run_driver.step);
}

/// A module rooted at `root` that imports the interpreter, for its target and optimize mode.
fn over(b: *std.Build, interp: *std.Build.Module, root: []const u8) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = b.path(root),
        .target = interp.resolved_target,
        .optimize = interp.optimize,
        .imports = &.{.{ .name = "stator_interp", .module = interp }},
    });
}
