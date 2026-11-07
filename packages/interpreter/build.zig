const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const runtime_lib = b.option(std.Build.LazyPath, "runtime", "libjsrt.a the tests and drivers link (default ../runtime/build/libjsrt.a)") orelse
        b.path("../runtime/build/libjsrt.a");

    const jstext = b.dependency("jstext", .{ .target = target, .optimize = optimize }).module("jstext");

    // stator-ts's `lib.zig` exports the checker's modules but not the parser, so the parser is a
    // module of its own, rooted at its file: everything it reaches is imported relative to it, and
    // nothing it reaches needs a module stator-ts's own build adds (docs/INTERPRETER.md §1).
    const stator_ts = b.dependency("stator_ts", .{ .target = target, .optimize = optimize });
    const parser = b.createModule(.{
        .root_source_file = stator_ts.path("src/parser.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "jstext", .module = jstext }},
    });

    // The runtime's C ABI, translated from the header compiled code includes: the VM calls what
    // compiled dynamic code calls, with no layout mirrored by hand (docs/INTERPRETER.md §2).
    const jsrt_c = b.addTranslateC(.{
        .root_source_file = b.path("src/jsrt_c.h"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    jsrt_c.addIncludePath(b.path("../runtime/include"));

    const interp = b.addModule("stator_interp", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "parser", .module = parser },
            .{ .name = "jstext", .module = jstext },
            .{ .name = "jsrt", .module = jsrt_c.createModule() },
        },
    });

    // The runtime links this archive; its `jsrt_*` imports resolve there (T14.3).
    const lib = b.addLibrary(.{ .name = "jsrt_interp", .root_module = over(b, interp, "src/capi.zig") });
    const install_lib = b.addInstallArtifact(lib, .{});
    b.getInstallStep().dependOn(&install_lib.step);
    b.step("lib", "Build libjsrt_interp.a").dependOn(&install_lib.step);

    const parse_driver = b.addExecutable(.{ .name = "test262-parse", .root_module = over(b, interp, "test262/parse.zig") });
    const run_driver = b.addExecutable(.{ .name = "test262-run", .root_module = over(b, interp, "test262/run.zig") });
    linkRuntime(b, run_driver.root_module, runtime_lib);

    const unit = b.addTest(.{ .root_module = interp });
    linkRuntime(b, unit.root_module, runtime_lib);
    const test_step = b.step("test", "Run the interpreter's tests");
    test_step.dependOn(&b.addRunArtifact(unit).step);
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = parse_driver.root_module })).step);

    ratchet(b, parse_driver, "test262-parse", "Parse Test262's language/ tests and ratchet the pass counts");
    ratchet(b, run_driver, "test262-run", "Run Test262's language/ tests through the interpreter and ratchet the pass counts");
}

/// A driver step over the Test262 corpus: it finds its baseline and the default corpus from the
/// package directory, and always runs, because the corpus is outside the build graph.
fn ratchet(b: *std.Build, driver: *std.Build.Step.Compile, name: []const u8, description: []const u8) void {
    const run = b.addRunArtifact(driver);
    run.addDirectoryArg2(b.path("."), .{ .prefix = "--package=", .make_absolute = true });
    run.addPassthruArgs();
    run.has_side_effects = true;
    b.step(name, description).dependOn(&run.step);
}

/// Links the prebuilt runtime archive (`pnpm run runtime`) and the collector it was built against:
/// the archive references Boehm exactly when pkg-config finds it, which is the test the runtime's
/// justfile makes.
fn linkRuntime(b: *std.Build, m: *std.Build.Module, runtime_lib: std.Build.LazyPath) void {
    m.addObjectFile(runtime_lib);
    m.linkSystemLibrary("m", .{});
    var code: u8 = undefined;
    const libs = b.runAllowFail(&.{ "pkg-config", "--libs", "bdw-gc" }, &code, .ignore) catch return;
    var it = std.mem.tokenizeAny(u8, libs, " \n");
    while (it.next()) |flag| {
        if (std.mem.startsWith(u8, flag, "-L")) m.addLibraryPath(.{ .cwd_relative = flag[2..] });
        if (std.mem.startsWith(u8, flag, "-l")) m.linkSystemLibrary(flag[2..], .{});
    }
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
