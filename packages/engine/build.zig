const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // stator-ts's `lib.zig` exports the checker's modules but not the parser, so the parser is a
    // module of its own, rooted at `erase.zig`: the parser, and the type erasure TypeScript input
    // goes through (docs/ENGINE.md §2). Everything it reaches is imported relative to it; the
    // emitter needs jstext (docs/INTERPRETER.md §1).
    const stator_ts = b.dependency("stator_ts", .{ .target = target, .optimize = optimize });
    const jstext = b.dependency("jstext", .{ .target = target, .optimize = optimize }).module("jstext");
    const parser = b.createModule(.{
        .root_source_file = stator_ts.path("src/erase.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "jstext", .module = jstext }},
    });

    // The runtime's headers, translated the way its memory core translates them, so the VM reads
    // the same layouts the C objects were compiled with (docs/INTERPRETER.md §4).
    const jsrt_h = b.addTranslateC(.{
        .root_source_file = b.path("../runtime/src/jsrt_c.h"),
        .target = target,
        .optimize = optimize,
    });
    jsrt_h.addIncludePath(b.path("../runtime/include"));
    jsrt_h.addIncludePath(b.path("../runtime/src"));

    // pyrlyn/jit's IR, register allocator and backends: the JIT tier lowers bytecode into its IR
    // (src/jit/, docs/ENGINE.md §3).
    const pyrlyn_jit = b.dependency("pyrlyn_jit", .{ .target = target, .optimize = optimize }).module("pyrlyn_jit");

    const interp = b.addModule("stator_interp", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "parser", .module = parser },
            .{ .name = "jsrt_c", .module = jsrt_h.createModule() },
            .{ .name = "pyrlyn_jit", .module = pyrlyn_jit },
        },
    });
    // What executes JavaScript links the runtime it calls: the archive `pnpm run runtime` builds,
    // or another flavor's (`-Druntime=packages/runtime/build-asan/libjsrt.a`).
    const runtime = b.option([]const u8, "runtime", "libjsrt.a to link") orelse "../runtime/build/libjsrt.a";

    // A program with an `Interpret` node links this archive beside the runtime's, whose `jsrt_*`
    // symbols its imports resolve to (docs/INTERPRETER.md §9). Position-independent, because it
    // links into PIE executables; split into sections, so the program link dead-strips what the
    // program never reaches. The packages/engine justfile builds it for the compiler.
    const lib_root = over(b, interp, "src/capi.zig");
    lib_root.pic = true;
    lib_root.stack_check = false;
    const lib = b.addLibrary(.{ .name = "jsrt_interp", .root_module = lib_root });
    lib.link_function_sections = true;
    lib.link_data_sections = true;
    const install_lib = b.addInstallArtifact(lib, .{});
    b.getInstallStep().dependOn(&install_lib.step);
    b.step("lib", "Build libjsrt_interp.a").dependOn(&install_lib.step);

    // The engine's command line (docs/ENGINE.md §5): runs a .js or .ts file in either mode.
    const cli = b.addExecutable(.{ .name = "stator-engine", .root_module = over(b, interp, "src/cli.zig") });
    linkRuntime(b, cli.root_module, runtime);
    const install_cli = b.addInstallArtifact(cli, .{});
    b.step("cli", "Build the stator-engine command line").dependOn(&install_cli.step);
    const run_cli = b.addRunArtifact(cli);
    run_cli.addPassthruArgs();
    b.step("run", "Run stator-engine with the arguments after --").dependOn(&run_cli.step);

    const driver = b.addExecutable(.{ .name = "test262-parse", .root_module = over(b, interp, "test262/parse.zig") });
    // The execution driver only spawns the compiled host (test262/host.ts), so it links neither
    // the interpreter nor the runtime.
    const exec = b.addExecutable(.{ .name = "test262-exec", .root_module = b.createModule(.{
        .root_source_file = b.path("test262/exec.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    }) });
    const unit = b.addTest(.{ .root_module = interp });
    linkRuntime(b, unit.root_module, runtime);
    const test_step = b.step("test", "Run the interpreter's tests");
    test_step.dependOn(&b.addRunArtifact(unit).step);
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = driver.root_module })).step);
    const exec_unit = b.addTest(.{ .root_module = exec.root_module });
    test_step.dependOn(&b.addRunArtifact(exec_unit).step);

    const run_driver = b.addRunArtifact(driver);
    // The package directory, from which the driver finds its baseline and the default corpus.
    run_driver.addDirectoryArg2(b.path("."), .{ .prefix = "--package=", .make_absolute = true });
    run_driver.addPassthruArgs();
    // The corpus is outside the build graph, so a cached result would skip a changed corpus.
    run_driver.has_side_effects = true;
    b.step("test262-parse", "Parse Test262's language/ tests and ratchet the pass counts").dependOn(&run_driver.step);

    const run_exec = b.addRunArtifact(exec);
    run_exec.addDirectoryArg2(b.path("."), .{ .prefix = "--package=", .make_absolute = true });
    run_exec.addPassthruArgs();
    run_exec.has_side_effects = true;
    b.step("test262-exec", "Run Test262's language/ tests through the interpreter and ratchet the pass counts").dependOn(&run_exec.step);
}

/// The runtime archive and the system libraries it records in `link-flags.txt` (SYS_LIBS in
/// packages/runtime/justfile): the collector is compiled into the archive (plan-notes 407).
fn linkRuntime(b: *std.Build, m: *std.Build.Module, archive: []const u8) void {
    m.addObjectFile(b.path(archive));
    m.link_libc = true;
    m.linkSystemLibrary("m", .{});
    m.linkSystemLibrary("pthread", .{});
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
