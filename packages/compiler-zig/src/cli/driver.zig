//! The `stator` command: argv in, exit code out. `src/cli/root.zig` holds what can be tested alone;
//! this file is what needs the frontend, so it is reached from `src/root.zig`.
const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const fspath = std.fs.path;
const Environ = std.process.Environ;
const stator_ts = @import("stator_ts");
const pool = stator_ts.pool;

const args = @import("args.zig");
const compile_jobs = @import("compile_jobs.zig");
const crash = @import("crash.zig");
const env_file = @import("env_file.zig");
const failure = @import("failure.zig");
const library = @import("library.zig");
const link = @import("link.zig");
const outputs = @import("outputs.zig");
const terminal = @import("terminal.zig");
const Error = failure.Error;
const Reporter = failure.Reporter;
const Named = outputs.Named;

const support = @import("../support/root.zig");
const report = support.diagnostics;
const Diagnostic = report.Diagnostic;
const Mode = report.Mode;

const gate = @import("../frontend/gate.zig");
const gate_api = @import("../frontend/gate_api.zig");
const hir_nodes = @import("../hir/nodes.zig");
const hir_json = @import("../hir/json.zig");
const lowering = @import("../lower/program.zig");
const passes = @import("../passes/root.zig");
const codegen = @import("../codegen/root.zig");
const hir_verify = @import("../hir/verify.zig");
const verdict_walk = @import("verdict.zig");
const gate_extern = @import("../frontend/gate_extern.zig");
const graph = @import("../frontend/graph.zig");
const location = @import("../frontend/location.zig");
const node_edge = @import("../frontend/node.zig");
const program = @import("../frontend/program.zig");
const std_edge = @import("../frontend/std.zig");
const ffi_gen = @import("../ffigen/command.zig");

const oom = failure.oom;

/// `src/cli/root.zig` is tested alone, so `config` cannot name the diagnostics' `Mode`.
fn modeOf(mode: args.Mode) Mode {
    return switch (mode) {
        .ts => .ts,
        .js => .js,
    };
}

const Stream = enum { stdout, stderr };

fn streamFile(stream: Stream) Io.File {
    return switch (stream) {
        .stdout => Io.File.stdout(),
        .stderr => Io.File.stderr(),
    };
}

fn columnsOf(file: Io.File) usize {
    if (builtin.os.tag == .windows) return 0;
    var size: std.posix.winsize = undefined;
    const rc = std.posix.system.ioctl(file.handle, std.posix.T.IOCGWINSZ, &size);
    return if (std.posix.errno(rc) == .SUCCESS) size.col else 0;
}

fn controllingColumns(io: Io) usize {
    const tty = Io.Dir.cwd().openFile(io, "/dev/tty", .{}) catch return 0;
    defer tty.close(io);
    return columnsOf(tty);
}

const Context = struct {
    a: Allocator,
    io: Io,
    env: *Environ.Map,
    r: *Reporter,
    cwd: []const u8,
    /// `packages/compiler-zig`: the sibling packages are found from here.
    home: []const u8,
    tp: *pool.ThreadPool,

    fn host(x: *const Context) link.Host {
        return .{ .a = x.a, .io = x.io, .env = x.env, .r = x.r };
    }

    fn columnsOn(x: *const Context, file: Io.File) usize {
        const stream_columns = if (file.isTty(x.io) catch false) columnsOf(file) else 0;
        return terminal.terminalColumns(stream_columns, x.env.get("COLUMNS"), x.env.get("LINES"), controllingColumns(x.io));
    }

    fn print(x: *const Context, lines: []const terminal.Line, stream: Stream) void {
        if (lines.len == 0) return;
        const file = streamFile(stream);
        const on_tty = file.isTty(x.io) catch false;
        file.writeStreamingAll(x.io, terminal.render(x.a, lines, x.columnsOn(file), on_tty)) catch {};
    }

    fn compilerPackage(x: *const Context) []const u8 {
        return fspath.resolve(x.a, &.{ x.home, "..", "compiler" }) catch oom();
    }

    fn envValue(x: *const Context, name: []const u8) ?[]const u8 {
        return x.env.get(name);
    }

    fn paths(x: *const Context) *const program.Paths {
        const compiler = x.compilerPackage();
        const out = x.a.create(program.Paths) catch oom();
        out.* = .{
            .globals = fspath.join(x.a, &.{ compiler, "src", "frontend", "lib", "stator.globals.d.ts" }) catch oom(),
            .lib_dir = fspath.join(x.a, &.{ compiler, "node_modules", "typescript", "lib" }) catch oom(),
            .std_package = std_edge.open(x.a, x.io, x.envValue("STATOR_STD_ROOT"), x.home),
            .node_package = node_edge.open(x.a, x.io, x.envValue("STATOR_NODE_ROOT"), x.home),
        };
        return out;
    }

    fn runtimeFlavor(x: *const Context) support.features.RuntimeFlavor {
        return support.features.runtimeFlavor(x.envValue("STATOR_RUNTIME"));
    }

    fn resolveRuntime(x: *const Context) link.Runtime {
        const root = support.package_root.packageRoot(x.a, x.io, x.envValue("STATOR_RUNTIME_ROOT"), x.home, "runtime", "include") catch oom();
        const flavor: link.Flavor = switch (x.runtimeFlavor()) {
            .default => .default,
            .asan => .asan,
            .intl => .intl,
        };
        return link.Runtime.at(x.a, flavor, root);
    }
};

// ---------------------------------------------------------------------------------------------
// The frontend every command shares
// ---------------------------------------------------------------------------------------------

const Frontend = struct {
    loaded: program.Loaded,
    request: program.Request,
    paths: *const program.Paths,
};

const Load = struct {
    entry: []const u8,
    mode: Mode,
    bundler: args.Bundler,
    node: bool,
};

/// `bundler` is unused because the vendor step is not ported: a program with package imports gets
/// the `--bundler=none` answer from the gate.
fn loadFrontend(x: *const Context, load: Load) Error!Frontend {
    if (!link.exists(x.io, load.entry)) return x.r.fail("STA0007", "entry file \"{s}\" does not exist", .{load.entry});
    const paths = x.paths();
    var request: program.Request = .{
        .entry = fspath.resolve(x.a, &.{ x.cwd, load.entry }) catch oom(),
        .mode = load.mode,
        .node = load.node,
        .paths = paths,
    };
    const base = program.load(x.a, x.io, x.tp, request);
    if (!load.node) return .{ .loaded = base, .request = request, .paths = paths };
    const entry_file = base.entry_file orelse return .{ .loaded = base, .request = request, .paths = paths };
    var questions = program.questions(x.a, base.session, request);
    const rewrites = x.a.create(stator_ts.project.Overlay) catch oom();
    rewrites.* = location.locationRewrites(x.a, base.session.prog, &questions, entry_file, paths.std_package, paths.node_package);
    if (rewrites.count() == 0) return .{ .loaded = base, .request = request, .paths = paths };
    request.overlay = rewrites;
    return .{ .loaded = program.load(x.a, x.io, x.tp, request), .request = request, .paths = paths };
}

fn gateProgram(x: *const Context, frontend: *const Frontend) []const Diagnostic {
    var g = program.questions(x.a, frontend.loaded.session, frontend.request);
    g.paths = frontend.paths;
    g.runtime = x.envValue("STATOR_RUNTIME");
    gate.gateProgram(&g, frontend.loaded.session.prog);
    return g.diagnostics.items;
}

fn lowerProgram(x: *const Context, frontend: *const Frontend, order: graph.ModuleOrder) lowering.Result {
    const g = x.a.create(gate_api.Gate) catch oom();
    g.* = program.questions(x.a, frontend.loaded.session, frontend.request);
    g.paths = frontend.paths;
    g.runtime = x.envValue("STATOR_RUNTIME");
    const files = x.a.alloc(*stator_ts.ast.File, order.order.len) catch oom();
    for (order.order, files) |sf, *file| file.* = sf.file;
    return lowering.lowerProgram(x.a, .{ .g = g, .session = frontend.loaded.session, .files = files, .runtime_dynamic = frontend.loaded.runtime_dynamic_names });
}

/// `/` is what the checker stores on every platform; the user reads the platform's own form.
fn platformDiagnostics(a: Allocator, diagnostics: []const Diagnostic) []const Diagnostic {
    if (fspath.sep == '/') return diagnostics;
    const out = a.dupe(Diagnostic, diagnostics) catch oom();
    for (out) |*d| {
        const file = a.dupe(u8, d.file) catch oom();
        std.mem.replaceScalar(u8, file, '/', fspath.sep);
        d.file = file;
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------------------------

fn diagnosticLines(a: Allocator, diagnostics: []const Diagnostic) []const terminal.Line {
    const lines = a.alloc(terminal.Line, diagnostics.len) catch oom();
    for (diagnostics, lines) |d, *line| line.* = .{
        .text = report.render(a, d) catch oom(),
        .color = if (d.class == .@"not-yet") .yellow else .red,
    };
    return lines;
}

/// A `not-yet` and a `never` both stop the build: the difference is what the user does about it.
fn reportStops(x: *const Context, diagnostics: []const Diagnostic) bool {
    const shown = platformDiagnostics(x.a, diagnostics);
    x.print(diagnosticLines(x.a, shown), .stderr);
    return diagnostics.len > 0;
}

const ExportSurface = struct {
    symbols: []const []const u8,
    needs_jsrt_value: bool,
    abi_version: u32,
};

const Compiled = struct {
    c: []const u8,
    link_flags: []const []const u8 = &.{},
    /// The graph holds a `std/*` file, so the link owes `libjsrt_std.a`.
    std: bool,
    flavor: support.features.RuntimeFlavor,
    /// Every source file of the program, so `build` can refuse an output that names one.
    inputs: []const []const u8,
    header: ?[]const u8 = null,
    export_surface: ?ExportSurface = null,
};

const Compile = struct {
    load: Load,
    unit: ?[]const u8,
};

/// Optimization runs before the verifier, so the verifier checks what the emitter will see: the
/// verifier is the only thing between a lowering bug and silently wrong C.
fn emitC(x: *const Context, module: *const hir_nodes.Module) Error![]const u8 {
    const optimized = passes.optimize(x.a, module, &.{}) catch |err| return x.r.fail("STA4072", "the passes stopped: {t}", .{err});
    const problems = hir_verify.verifyHir(x.a, optimized) catch oom();
    if (problems.len > 0) {
        var lines: std.ArrayList(terminal.Line) = .empty;
        for (problems) |p| {
            lines.append(x.a, .{ .text = std.fmt.allocPrint(x.a, "stator: {s} internal error in {s}: {s}", .{ p.code, p.kind, p.message }) catch oom(), .color = .red }) catch oom();
        }
        lines.append(x.a, .{ .text = "stator: this is a compiler bug — please report it with the input", .color = .red }) catch oom();
        x.print(lines.items, .stderr);
        return error.Failed;
    }
    return switch (codegen.emitModule(x.a, optimized, null) catch oom()) {
        .source => |c| c,
        .internal => |message| internalFailure(x, message),
    };
}

fn lowered(x: *const Context, frontend: *const Frontend, order: graph.ModuleOrder, flavor: support.features.RuntimeFlavor) Error!?Compiled {
    const result = lowerProgram(x, frontend, order);
    if (reportStops(x, result.diagnostics)) return null;
    const c = try emitC(x, result.module orelse return null);
    const prog = frontend.loaded.session.prog;
    var inputs: std.ArrayList([]const u8) = .empty;
    for (prog.files.items) |sf| inputs.append(x.a, sf.file.path) catch oom();
    var uses_std = false;
    for (order.order) |sf| uses_std = uses_std or frontend.paths.std_package.isSourceFile(sf.file.path);
    var questions = program.questions(x.a, frontend.loaded.session, frontend.request);
    const link_flags = gate_extern.collectLinkFlags(&questions, prog.files.items);
    return .{ .c = c, .link_flags = link_flags, .std = uses_std, .flavor = flavor, .inputs = inputs.items };
}

fn compileToC(x: *const Context, compile: Compile) Error!?Compiled {
    const frontend = try loadFrontend(x, compile.load);
    if (reportStops(x, frontend.loaded.diagnostics)) return null;
    // Read where the gate reads it, so the link can check it got the same answer.
    const flavor = x.runtimeFlavor();
    if (reportStops(x, gateProgram(x, &frontend))) return null;
    const entry_file = frontend.loaded.entry_file orelse return x.r.fail("STA0007", "entry file \"{s}\" does not exist", .{compile.load.entry});
    const order = graph.moduleOrder(x.a, frontend.loaded.session.prog, entry_file, compile.load.mode);
    if (reportStops(x, order.diagnostics)) return null;
    return lowered(x, &frontend, order, flavor);
}

fn demandCompileJobs(x: *const Context) Error!compile_jobs.Jobs {
    var invalid: []const u8 = "";
    const hosts = std.Thread.getCpuCount() catch 1;
    return compile_jobs.resolve(x.envValue("STATOR_COMPILE_JOBS"), hosts, &invalid) orelse
        x.r.fail("STA0021", "unknown compile jobs \"{s}\" in the environment variable STATOR_COMPILE_JOBS (expected an integer >= 1)", .{invalid});
}

fn sanitized(a: Allocator, raw: []const u8) []const u8 {
    const out = a.dupe(u8, raw) catch oom();
    for (out) |*b| if (!std.ascii.isAlphanumeric(b.*) and b.* != '_') {
        b.* = '_';
    };
    return out;
}

/// The entry's basename without its extension, safe to embed in a C symbol.
fn defaultUnit(a: Allocator, entry: []const u8) []const u8 {
    const base = entry[(std.mem.lastIndexOfAny(u8, entry, "/\\") orelse return unitOf(a, entry)) + 1 ..];
    return unitOf(a, base);
}

fn unitOf(a: Allocator, base: []const u8) []const u8 {
    const stem = base[0 .. std.mem.lastIndexOfScalar(u8, base, '.') orelse base.len];
    const cleaned = sanitized(a, stem);
    if (cleaned.len == 0 or std.ascii.isDigit(cleaned[0])) return std.fmt.allocPrint(a, "_{s}", .{cleaned}) catch oom();
    return cleaned;
}

const LibraryOutputs = struct { pc: Named, format: library.ObjectFormat };

fn libraryOutputs(x: *const Context, b: args.Build) Error!LibraryOutputs {
    if (b.emit_header == null) return x.r.fail("STA0004", "--emit=lib requires --emit-header=<h> (config \"emitHeader\"): the header is the library's C surface", .{});
    const name = library.libraryName(b.out) orelse return x.r.fail("STA0004", "--emit=lib requires -o lib<name>.a, not \"{s}\" — the consumer links it as -l<name>", .{b.out});
    const format = library.objectFormat() orelse return x.r.fail("STA1219", "--emit=lib is not yet supported on Windows (docs/FFI.md §8) — use --emit-header for an object, linked with the runtime archive", .{});
    return .{ .pc = .{ .role = "the --emit=lib pkg-config file", .path = library.pkgConfigPath(x.a, b.out, name) }, .format = format };
}

fn stdRoot(x: *const Context) []const u8 {
    return support.package_root.packageRoot(x.a, x.io, x.envValue("STATOR_STD_ROOT"), x.home, "std", "src") catch oom();
}

const Writes = struct {
    b: args.Build,
    out: Named,
    header: ?Named,
    kept_c: ?Named,
    lib: ?LibraryOutputs,
    unit: ?[]const u8,
    jobs: compile_jobs.Jobs,
    runtime: link.Runtime,
    cc: link.Compiler,
};

fn writeObjectOrLibrary(x: *const Context, w: Writes, compiled: Compiled, header: Named) Error!void {
    const h = x.host();
    if (w.lib != null and compiled.export_surface != null and compiled.export_surface.?.needs_jsrt_value) {
        return x.r.fail("STA1220", "unit \"{s}\" has an export that crosses as jsrt_value, which --emit=lib does not support yet: the library's runtime is private, so a consumer has no runtime API to make or read one (docs/FFI.md §8) — keep plain C types, or use --emit-header without --emit=lib", .{w.unit orelse ""});
    }
    try outputs.write(x.io, x.r, header, compiled.header orelse "");
    // A unit exposed to C links at the consumer: `clang -c`, no `-ljsrt`, no extern flags. Only
    // `main` is absent, which is what makes this an object and not a program.
    const scratch = try link.makeTempDir(h, "stator-");
    defer link.removeTree(x.io, scratch);
    const c_target = w.kept_c orelse Named{ .role = "the C file", .path = fspath.join(x.a, &.{ scratch, "module.c" }) catch oom() };
    try outputs.write(x.io, x.r, c_target, compiled.c);
    const lib = w.lib orelse return link.compileObject(h, w.cc, c_target.path, w.b.out, w.b.opt, w.runtime);
    const object = fspath.join(x.a, &.{ scratch, "unit.o" }) catch oom();
    try link.compileObject(h, w.cc, c_target.path, object, w.b.opt, w.runtime);
    const std_archive: ?[]const u8 = if (compiled.std) link.stdArchive(x.a, stdRoot(x)) else null;
    try link.requireLinkArchives(h, archivesOf(x, compiled, w.runtime));
    try link.requireLinkFlagsSupported(h, w.cc, w.runtime, externFlags(x, compiled, w.b));

    var archives: std.ArrayList([]const u8) = .empty;
    if (std_archive) |archive| archives.append(x.a, archive) catch oom();
    archives.append(x.a, w.runtime.archive) catch oom();
    var libs: std.ArrayList([]const u8) = .empty;
    if (w.runtime.sanitized()) libs.append(x.a, "-fsanitize=address,undefined") catch oom();
    libs.appendSlice(x.a, link.systemLinkFlags(x.a, x.io, w.runtime, externFlags(x, compiled, w.b))) catch oom();
    const surface = compiled.export_surface;
    try library.writeStaticLibrary(h, .{
        .cc = w.cc.command,
        .object = object,
        .archives = archives.items,
        .symbols = if (surface) |s| s.symbols else &.{},
        .out = w.out,
        .pc = lib.pc,
        .header = header.path,
        .unit = w.unit orelse "",
        .libs = libs.items,
        .scratch = scratch,
        .format = lib.format,
        .debug = w.runtime.sanitized(),
        .abi_version = if (surface) |s| s.abi_version else 0,
    });
}

fn externFlags(x: *const Context, compiled: Compiled, b: args.Build) []const []const u8 {
    return std.mem.concat(x.a, []const u8, &.{ compiled.link_flags, b.link_flags }) catch oom();
}

fn archivesOf(x: *const Context, compiled: Compiled, runtime: link.Runtime) link.Archives {
    const std_root = stdRoot(x);
    return .{
        .runtime = runtime,
        .std_lib = if (compiled.std) .{ .archive = link.stdArchive(x.a, std_root), .root = std_root } else null,
    };
}

fn writeExecutable(x: *const Context, w: Writes, compiled: Compiled) Error!void {
    const h = x.host();
    // Only a kept `.c` outlives the build, beside the executable where the user can find it.
    const scratch: ?[]const u8 = if (w.b.keep_c) null else try link.makeTempDir(h, "stator-");
    defer if (scratch) |dir| link.removeTree(x.io, dir);
    const c_target = w.kept_c orelse Named{ .role = "the C file", .path = fspath.join(x.a, &.{ scratch.?, "module.c" }) catch oom() };
    try outputs.write(x.io, x.r, c_target, compiled.c);

    const flags = externFlags(x, compiled, w.b);
    const std_archive: ?[]const u8 = if (compiled.std) link.stdArchive(x.a, stdRoot(x)) else null;
    const line: link.LinkLine = .{ .inputs = &.{c_target.path}, .out = w.b.out, .opt = w.b.opt, .extern_flags = flags, .std_archive = std_archive, .runtime = w.runtime };
    const archives = archivesOf(x, compiled, w.runtime);
    const split = compile_jobs.shouldSplit(x.a, compiled.c, w.jobs.jobs, w.jobs.explicit) catch |err| return internalFailure(x, @errorName(err));
    if (!split) return link.link(h, w.cc, line, archives);
    const parts = try link.makeTempDir(h, "stator-jobs-");
    defer link.removeTree(x.io, parts);
    try link.linkParallel(h, w.cc, compiled.c, parts, line, archives, w.jobs.jobs);
}

fn internalFailure(x: *const Context, message: []const u8) Error {
    return x.r.fail("STA4072", "internal error: {s} — this is a compiler bug; report it with the input that triggered it", .{message});
}

/// The one place a build decides its C compiler: chosen, probed once, and warned about when an
/// explicit choice skips the macOS ASan override (`cc.zig`).
fn resolveCompiler(x: *const Context, explicit: ?link.Choice, runtime: link.Runtime) Error!link.Compiler {
    const h = x.host();
    const chosen = try link.chooseCC(h, explicit, runtime);
    if (chosen.warning) |warning| x.print(&.{.{ .text = std.fmt.allocPrint(x.a, "stator: warning: {s}", .{warning}) catch oom() }}, .stderr);
    return link.detectCC(h, chosen.choice);
}

fn runBuild(x: *const Context, b: args.Build) Error!u8 {
    const jobs = try demandCompileJobs(x);
    if (b.unit_name) |name| if (!support.names.isWord(name)) {
        return x.r.fail("STA0004", "unit name \"{s}\" (--unit-name, config \"unitName\") may hold only letters, digits and _ — it becomes part of every exported C symbol", .{name});
    };
    const lib: ?LibraryOutputs = if (b.emit_lib) try libraryOutputs(x, b) else null;
    const unit: ?[]const u8 = if (b.emit_header == null) null else b.unit_name orelse sanitized(x.a, defaultUnit(x.a, b.entry));

    const out: Named = .{ .role = "-o", .path = b.out };
    const header: ?Named = if (b.emit_header) |path| .{ .role = "--emit-header", .path = path } else null;
    const kept_c: ?Named = if (b.keep_c and !b.emit_c) .{ .role = "the --keep-c file", .path = std.fmt.allocPrint(x.a, "{s}.c", .{b.out}) catch oom() } else null;
    var targets: std.ArrayList(Named) = .empty;
    targets.append(x.a, out) catch oom();
    if (header) |target| targets.append(x.a, target) catch oom();
    if (kept_c) |target| targets.append(x.a, target) catch oom();
    if (lib) |target| targets.append(x.a, target.pc) catch oom();

    // Refused before compiling, so a slip like `-o app.ts` costs nothing and destroys nothing.
    try outputs.refuseAliased(x.a, x.io, x.r, targets.items, &.{.{ .role = "the entry file", .path = b.entry }});
    if (!b.emit_c) try outputs.requireWritable(x.a, x.io, x.r, out);

    const runtime = x.resolveRuntime();
    const load: Load = .{ .entry = b.entry, .mode = modeOf(b.mode), .bundler = b.bundler, .node = b.node };
    const compiled = (try compileToC(x, .{ .load = load, .unit = unit })) orelse return 1;

    const inputs = x.a.alloc(Named, compiled.inputs.len) catch oom();
    for (compiled.inputs, inputs) |path, *input| input.* = .{ .role = "a source file of the program", .path = path };
    try outputs.refuseAliased(x.a, x.io, x.r, targets.items, inputs);

    if (b.emit_c) {
        try outputs.write(x.io, x.r, out, compiled.c);
        if (header) |target| try outputs.write(x.io, x.r, target, compiled.header orelse "");
        return 0;
    }
    const cc = try resolveCompiler(x, b.cc, runtime);
    const writes: Writes = .{ .b = b, .out = out, .header = header, .kept_c = kept_c, .lib = lib, .unit = unit, .jobs = jobs, .runtime = runtime, .cc = cc };
    if (header) |target| {
        try writeObjectOrLibrary(x, writes, compiled, target);
    } else {
        try writeExecutable(x, writes, compiled);
    }
    return 0;
}

// ---------------------------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------------------------

const Verdict = enum { static, dynamic, @"error", @"not-yet" };

const Explanation = struct {
    verdict: Verdict,
    code: ?[]const u8 = null,
    diagnostics: []const Diagnostic = &.{},
    functions: []const verdict_walk.FunctionReport = &.{},
    extern_calls: []const verdict_walk.ExternCallReport = &.{},
};

fn lessReport(_: void, l: Diagnostic, r: Diagnostic) bool {
    const by_file = std.mem.order(u8, l.file, r.file);
    if (by_file != .eq) return by_file == .lt;
    if (l.line != r.line) return l.line < r.line;
    return l.column < r.column;
}

fn firstOf(diagnostics: []const Diagnostic, class: report.Class) ?Diagnostic {
    for (diagnostics) |d| if (d.class == class) return d;
    return null;
}

fn classifyDiagnostics(a: Allocator, raw: []const Diagnostic) ?Explanation {
    const diagnostics = platformDiagnostics(a, raw);
    const decided = struct {
        fn make(gpa: Allocator, verdict: Verdict, d: Diagnostic, all: []const Diagnostic) Explanation {
            const sorted = gpa.dupe(Diagnostic, all) catch oom();
            std.mem.sort(Diagnostic, sorted, {}, lessReport);
            return .{ .verdict = verdict, .code = d.code, .diagnostics = sorted };
        }
    }.make;
    if (firstOf(diagnostics, .never)) |d| return decided(a, .@"error", d, diagnostics);
    if (firstOf(diagnostics, .@"not-yet")) |d| return decided(a, .@"not-yet", d, diagnostics);
    for (diagnostics) |d| if (d.class == .@"error" or d.class == .internal) return decided(a, .@"error", d, diagnostics);
    return null;
}

fn explainFile(x: *const Context, e: args.Explain) Error!Explanation {
    const frontend = try loadFrontend(x, .{ .entry = e.entry, .mode = modeOf(e.mode), .bundler = e.bundler, .node = e.node });
    const first = std.mem.concat(x.a, Diagnostic, &.{ frontend.loaded.diagnostics, gateProgram(x, &frontend) }) catch oom();
    if (classifyDiagnostics(x.a, first)) |verdict| return verdict;
    const entry_file = frontend.loaded.entry_file orelse return x.r.fail("STA0007", "entry file \"{s}\" does not exist", .{e.entry});
    // The verdict covers the whole graph, as the build does: a cycle decides the entry's verdict.
    const order = graph.moduleOrder(x.a, frontend.loaded.session.prog, entry_file, modeOf(e.mode));
    if (classifyDiagnostics(x.a, order.diagnostics)) |verdict| return verdict;
    const result = lowerProgram(x, &frontend, order);
    if (classifyDiagnostics(x.a, result.diagnostics)) |verdict| return verdict;
    // Lowering gave up without saying why: a bug, and `static` here would be a false claim.
    const module = result.module orelse return .{ .verdict = .@"error", .code = "STA4021" };
    const found = verdict_walk.reports(x.a, module) catch |err| return x.r.fail("STA4072", "walking the HIR: {t}", .{err});
    return .{
        .verdict = if (verdict_walk.hasUnknown(x.a, module)) .dynamic else .static,
        .functions = found.functions,
        .extern_calls = found.extern_calls,
    };
}

fn writeJson(a: Allocator, result: Explanation) []const u8 {
    var buffer: Io.Writer.Allocating = .init(a);
    const w = &buffer.writer;
    writeJsonTo(w, result) catch oom();
    return buffer.written();
}

fn writeJsonTo(w: *Io.Writer, result: Explanation) Io.Writer.Error!void {
    try w.print("{{\"verdict\":\"{t}\"", .{result.verdict});
    if (result.code) |code| {
        try w.print(",\"code\":\"{s}\",\"diagnostics\":[", .{code});
        for (result.diagnostics, 0..) |d, i| {
            if (i != 0) try w.writeByte(',');
            try w.writeAll("{\"file\":");
            try report.writeJsonString(w, d.file);
            try w.print(",\"line\":{d},\"column\":{d},\"code\":\"{s}\",\"mode\":\"{t}\",\"message\":", .{ d.line, d.column, d.code, d.mode });
            try report.writeJsonString(w, d.message);
            try w.writeByte('}');
        }
        try w.writeByte(']');
    }
    if (result.code == null) {
        try w.writeAll(",\"functions\":[");
        for (result.functions, 0..) |f, i| {
            if (i != 0) try w.writeByte(',');
            try w.writeAll("{\"name\":");
            try report.writeJsonString(w, f.name);
            try w.print(",\"line\":{d},\"provenance\":\"{t}\",\"verdict\":\"{t}\"}}", .{ f.line, f.provenance, f.verdict });
        }
        try w.writeByte(']');
        // Absent rather than empty: reports without an extern call stay as they always were.
        if (result.extern_calls.len > 0) {
            try w.writeAll(",\"externCalls\":[");
            for (result.extern_calls, 0..) |c, i| {
                if (i != 0) try w.writeByte(',');
                try w.writeAll("{\"name\":");
                try report.writeJsonString(w, c.name);
                try w.print(",\"line\":{d}}}", .{c.line});
            }
            try w.writeByte(']');
        }
    }
    try w.writeAll("}\n");
}

const CodeCount = struct { code: []const u8, count: u32 };

fn moreFrequent(_: void, l: CodeCount, r: CodeCount) bool {
    if (l.count != r.count) return l.count > r.count;
    return std.mem.lessThan(u8, l.code, r.code);
}

fn tally(a: Allocator, diagnostics: []const Diagnostic) []const CodeCount {
    var counts: std.ArrayList(CodeCount) = .empty;
    next: for (diagnostics) |d| {
        for (counts.items) |*seen| if (std.mem.eql(u8, seen.code, d.code)) {
            seen.count += 1;
            continue :next;
        };
        counts.append(a, .{ .code = d.code, .count = 1 }) catch oom();
    }
    std.mem.sort(CodeCount, counts.items, {}, moreFrequent);
    return counts.items;
}

fn verdictColor(verdict: Verdict) terminal.Color {
    return switch (verdict) {
        .static => .green,
        .dynamic => .cyan,
        .@"error" => .red,
        .@"not-yet" => .yellow,
    };
}

fn runExplain(x: *const Context, e: args.Explain) Error!u8 {
    const result = try explainFile(x, e);
    if (e.json) {
        Io.File.stdout().writeStreamingAll(x.io, writeJson(x.a, result)) catch {};
        return 0;
    }
    var lines: std.ArrayList(terminal.Line) = .empty;
    const head = if (result.code) |code|
        std.fmt.allocPrint(x.a, "{s}: {t} ({s})", .{ e.entry, result.verdict, code }) catch oom()
    else
        std.fmt.allocPrint(x.a, "{s}: {t}", .{ e.entry, result.verdict }) catch oom();
    lines.append(x.a, .{ .text = head, .color = verdictColor(result.verdict) }) catch oom();
    // A tally first, so a large input reads as how far it is from compiling, then every site.
    if (result.diagnostics.len > 1) {
        for (tally(x.a, result.diagnostics)) |row| {
            lines.append(x.a, .{ .text = std.fmt.allocPrint(x.a, "  {s} x{d}", .{ row.code, row.count }) catch oom() }) catch oom();
        }
    }
    for (result.diagnostics) |d| {
        const text = report.render(x.a, d) catch oom();
        lines.append(x.a, .{ .text = std.fmt.allocPrint(x.a, "  {s}", .{text}) catch oom() }) catch oom();
    }
    for (result.functions) |f| {
        lines.append(x.a, .{ .text = std.fmt.allocPrint(x.a, "  {d}: {s}: {t} ({t})", .{ f.line, f.name, f.verdict, f.provenance }) catch oom() }) catch oom();
    }
    for (result.extern_calls) |c| {
        lines.append(x.a, .{ .text = std.fmt.allocPrint(x.a, "  unchecked boundary: extern call '{s}' (line {d})", .{ c.name, c.line }) catch oom() }) catch oom();
    }
    x.print(lines.items, .stdout);
    return 0;
}

// ---------------------------------------------------------------------------------------------
// The top level
// ---------------------------------------------------------------------------------------------

fn readVersion(x: *const Context) Error![]const u8 {
    const path = fspath.join(x.a, &.{ x.compilerPackage(), "package.json" }) catch oom();
    const version = blk: {
        const text = Io.Dir.cwd().readFileAlloc(x.io, path, x.a, .unlimited) catch break :blk null;
        const parsed = std.json.parseFromSliceLeaky(std.json.Value, x.a, text, .{}) catch break :blk null;
        if (parsed != .object) break :blk null;
        const field = parsed.object.get("version") orelse break :blk null;
        break :blk if (field == .string) field.string else null;
    };
    return version orelse x.r.fail("STA4001", "package.json has no readable \"version\" field", .{});
}

fn runCommand(x: *const Context, command: args.Command) Error!u8 {
    switch (command) {
        .help => |which| {
            const usage = switch (which) {
                .top => args.usage,
                .build => args.usage_build,
                .explain => args.usage_explain,
            };
            x.print(&.{.{ .text = usage }}, .stdout);
            return 0;
        },
        .version => {
            x.print(&.{.{ .text = try readVersion(x) }}, .stdout);
            return 0;
        },
        .build => |b| return runBuild(x, b),
        .explain => |e| return runExplain(x, e),
    }
}

/// What `packages/tests/zigdiff/program.ts` compares against `createProgram`. The JSON is that script's, not a
/// contract.
fn dumpProgram(x: *const Context, operands: []const [:0]const u8) Error!u8 {
    if (operands.len != 3) return x.r.fail("STA0006", "dump-program <entry> <ts|js> <node|plain>", .{});
    const mode: Mode = if (std.mem.eql(u8, operands[1], "js")) .js else .ts;
    const frontend = try loadFrontend(x, .{ .entry = operands[0], .mode = mode, .bundler = .none, .node = std.mem.eql(u8, operands[2], "node") });
    const prog = frontend.loaded.session.prog;
    var files: std.ArrayList([]const u8) = .empty;
    var libs: std.ArrayList([]const u8) = .empty;
    for (prog.files.items) |sf| (if (sf.is_lib) &libs else &files).append(x.a, sf.file.path) catch oom();
    std.mem.sort([]const u8, files.items, {}, support.names.lessThan);
    std.mem.sort([]const u8, libs.items, {}, support.names.lessThan);
    const order: graph.ModuleOrder = if (frontend.loaded.entry_file) |entry| graph.moduleOrder(x.a, prog, entry, mode) else .{ .order = &.{}, .diagnostics = &.{} };

    var buffer: Io.Writer.Allocating = .init(x.a);
    const w = &buffer.writer;
    dumpJson(w, files.items, libs.items, order, frontend.loaded) catch oom();
    Io.File.stdout().writeStreamingAll(x.io, buffer.written()) catch {};
    return 0;
}

/// Separate from the `stator` command line: `packages/tests/zigdiff` reads the HIR here, canonical
/// JSON on stdout. Exit 1 is a refusal with its diagnostics on stderr, as a build would report it.
fn lowerCommand(x: *const Context, operands: []const [:0]const u8) Error!u8 {
    var mode: Mode = .ts;
    var node = false;
    var entry: ?[]const u8 = null;
    for (operands) |operand| {
        if (std.mem.eql(u8, operand, "--mode=js")) {
            mode = .js;
        } else if (std.mem.eql(u8, operand, "--mode=ts")) {
            mode = .ts;
        } else if (std.mem.eql(u8, operand, "--node")) {
            node = true;
        } else {
            entry = operand;
        }
    }
    const file = entry orelse return x.r.fail("STA0006", "lower [--mode=ts|js] [--node] <entry>", .{});
    const frontend = try loadFrontend(x, .{ .entry = file, .mode = mode, .bundler = .none, .node = node });
    if (reportStops(x, frontend.loaded.diagnostics)) return 1;
    if (reportStops(x, gateProgram(x, &frontend))) return 1;
    const entry_file = frontend.loaded.entry_file orelse return x.r.fail("STA0007", "entry file \"{s}\" does not exist", .{file});
    const order = graph.moduleOrder(x.a, frontend.loaded.session.prog, entry_file, mode);
    if (reportStops(x, order.diagnostics)) return 1;
    const result = lowerProgram(x, &frontend, order);
    if (reportStops(x, result.diagnostics)) return 1;
    const text = hir_json.write(x.a, result.module orelse return 1) catch |err| return x.r.fail("STA4072", "{t} writing the HIR", .{err});
    Io.File.stdout().writeStreamingAll(x.io, text) catch {};
    return 0;
}

fn dumpList(w: *Io.Writer, list: []const []const u8) Io.Writer.Error!void {
    try w.writeByte('[');
    for (list, 0..) |item, i| {
        if (i != 0) try w.writeByte(',');
        try report.writeJsonString(w, item);
    }
    try w.writeByte(']');
}

fn dumpDiagnostics(w: *Io.Writer, list: []const []const Diagnostic) Io.Writer.Error!void {
    try w.writeByte('[');
    var first = true;
    for (list) |part| for (part) |d| {
        if (!first) try w.writeByte(',');
        first = false;
        try w.writeAll("{\"file\":");
        try report.writeJsonString(w, d.file);
        try w.print(",\"line\":{d},\"column\":{d},\"code\":\"{s}\",\"class\":\"{t}\",\"message\":", .{ d.line, d.column, d.code, d.class });
        try report.writeJsonString(w, d.message);
        try w.writeByte('}');
    };
    try w.writeByte(']');
}

fn dumpJson(w: *Io.Writer, files: []const []const u8, libs: []const []const u8, order: graph.ModuleOrder, loaded: program.Loaded) Io.Writer.Error!void {
    try w.writeAll("{\"files\":");
    try dumpList(w, files);
    try w.writeAll(",\"libs\":");
    try dumpList(w, libs);
    try w.writeAll(",\"order\":[");
    for (order.order, 0..) |sf, i| {
        if (i != 0) try w.writeByte(',');
        try report.writeJsonString(w, sf.file.path);
    }
    try w.writeAll("],\"diagnostics\":");
    try dumpDiagnostics(w, &.{ loaded.diagnostics, order.diagnostics });
    try w.writeAll(",\"parse\":");
    try dumpDiagnostics(w, &.{loaded.parse_diagnostics});
    try w.writeAll("}\n");
}

fn compilerHome(a: Allocator, io: Io) []const u8 {
    const dir = std.process.executableDirPathAlloc(io, a) catch oom();
    const real = Io.Dir.cwd().realPathFileAlloc(io, dir, a) catch dir;
    return fspath.resolve(a, &.{ real, "..", ".." }) catch oom();
}

fn currentDirectory(a: Allocator, io: Io) []const u8 {
    return std.process.currentPathAlloc(io, a) catch oom();
}

/// `with-c <file.c> build ...` is the seam `lowered` describes.
/// The stack the checker gets on its workers, here too: the rest of the compiler walks the same
/// trees, and the depth of a tree is up to the source file.
pub fn run(init: std.process.Init) u8 {
    crash.install();
    var status: u8 = 1;
    const thread = std.Thread.spawn(.{ .stack_size = pool.threads.stack_size }, runOnStack, .{ init, &status }) catch |err| {
        Io.File.stderr().writeStreamingAll(init.io, std.fmt.allocPrint(init.arena.allocator(), "stator: STA4072 internal error: no thread for the compiler: {t}\n", .{err}) catch oom()) catch {};
        return 1;
    };
    thread.join();
    return status;
}

fn runOnStack(init: std.process.Init, status: *u8) void {
    status.* = runCompiler(init);
}

fn runCompiler(init: std.process.Init) u8 {
    const a = init.arena.allocator();
    const io = init.io;
    const argv = init.minimal.args.toSlice(a) catch oom();
    const cwd = currentDirectory(a, io);
    const env = init.environ_map;
    // A dev seam like `lower`, and ahead of the `.env` below: the tool reads no project state.
    if (argv.len >= 2 and std.mem.eql(u8, argv[1], "ffi-gen")) return ffi_gen.run(a, io, argv[2..], env.get("CC"), cwd);
    // Before anything reads the environment, and only Stator's keys: the file belongs to the
    // project being compiled, not to the user running Stator.
    const applied = env_file.apply(a, io, cwd, env);
    if (env_file.notice(a, applied)) |text| {
        Io.File.stderr().writeStreamingAll(io, std.fmt.allocPrint(a, "{s}\n", .{text}) catch oom()) catch {};
    }

    var reporter: Reporter = .{ .a = a };
    var workers = pool.ThreadPool.init(pool.jobCount(0));
    var x: Context = .{ .a = a, .io = io, .env = env, .r = &reporter, .cwd = cwd, .home = compilerHome(a, io), .tp = &workers };
    crash.configure(x.columnsOn(Io.File.stderr()), Io.File.stderr().isTty(io) catch false);
    var rest: []const [:0]const u8 = argv[@min(argv.len, 1)..];
    if (rest.len >= 1 and std.mem.eql(u8, rest[0], "dump-program")) {
        return dumpProgram(&x, rest[1..]) catch finish(&x);
    }
    if (rest.len >= 1 and std.mem.eql(u8, rest[0], "lower")) {
        return lowerCommand(&x, rest[1..]) catch finish(&x);
    }
    const plain = a.alloc([]const u8, rest.len) catch oom();
    for (rest, plain) |raw, *arg| arg.* = raw;

    const inputs: args.Inputs = .{ .cwd = cwd, .env_opt = env.get("STATOR_OPT"), .io = io };
    const code = blk: {
        const command = args.parse(a, &reporter, plain, inputs) catch break :blk @as(?u8, null);
        break :blk runCommand(&x, command) catch null;
    };
    return code orelse finish(&x);
}

fn finish(x: *const Context) u8 {
    const stopped = x.r.failure.?;
    x.print(&.{.{ .text = std.fmt.allocPrint(x.a, "stator: {s} {s}", .{ stopped.code, stopped.message }) catch oom(), .color = .red }}, .stderr);
    return 1;
}
