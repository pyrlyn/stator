//! The command line (`src/cli/main.ts`): flags, their refusals and the help text. A flag outside
//! its command is refused, not ignored: an inert flag hides a typo in a script.
const std = @import("std");
const Allocator = std.mem.Allocator;
const failure = @import("failure.zig");
const Reporter = failure.Reporter;
const Error = failure.Error;
const oom = failure.oom;
const config = @import("config.zig");

pub const Mode = config.Mode;

pub const usage =
    \\stator — ahead-of-time compiler for TypeScript/JavaScript
    \\
    \\Usage:
    \\  stator build <entry> -o <out> [--mode=ts|js] [--node] [--emit=c|lib] [--keep-c]
    \\    [--opt=0|1|2|3] [--link=<flags>]... [--emit-header=<h> [--unit-name=<unit>]]
    \\    [--bundler=vite|none|<module>]
    \\  stator explain <entry> [--mode=ts|js] [--node] [--json] [--bundler=vite|none|<module>]
    \\  stator <command> --help
    \\  stator --version
    \\  stator --help
    \\
    \\Modes:
    \\  ts  (default)  strict static TypeScript; .ts only; explicit any is an error
    \\  js             JavaScript, or JS + TS mixed; untyped code goes dynamic
    \\
    \\Platform:
    \\  --node         node:* and bare built-ins resolve to packages/node
    \\
    \\Config:
    \\  Every option can also come from ./stator.config.json (docs/CONFIG.md);
    \\  the command line wins. --config=<path> reads another file, --no-config
    \\  reads none.
;

pub const usage_build =
    \\Usage:
    \\  stator build <entry> -o <out> [--mode=ts|js] [--node] [--emit=c|lib] [--keep-c]
    \\    [--opt=0|1|2|3] [--link=<flags>]... [--emit-header=<h> [--unit-name=<unit>]]
    \\    [--bundler=vite|none|<module>]
    \\
    \\Flags:
    \\  -o, --out <out>  output path: native binary, or C with --emit=c
    \\  --mode ts|js     strict ts (default) or dynamic js; diagnostics only
    \\  --node           the Node platform: node:* and bare built-ins resolve
    \\                   to packages/node (docs/MODES.md §6)
    \\  --emit=c         stop after writing C to <out>; skip the C compiler
    \\  --keep-c         keep the intermediate .c next to the binary
    \\  --opt 0|1|2|3    clang -O level (default 2; or STATOR_OPT)
    \\  --link <flags>   extra clang link flags (repeatable; splits on spaces);
    \\                   joins the @statorLink pragma flags (docs/FFI.md)
    \\  --emit-header <h> write a C header for the unit's exports (docs/FFI.md);
    \\                   -o names a relocatable object, not an executable
    \\  --emit=lib       with --emit-header: -o lib<name>.a is a static library
    \\                   with a private runtime, plus lib<name>.pc beside it
    \\  --unit-name <unit> prefix for stator_<unit>_<name> (default: entry basename)
    \\  --bundler <b>    js mode: bundles package imports and CommonJS files;
    \\                   vite (default), none, or an adapter module (BUNDLER.md)
    \\  --emit=binary    build a binary (default; overrides "emit": "c" or "lib")
    \\
++ config_help;

pub const usage_explain =
    \\Usage:
    \\  stator explain <entry> [--mode=ts|js] [--node] [--json] [--bundler=<b>]
    \\
    \\Reports the file verdict: static | dynamic | error | not-yet, with the
    \\STA code and every diagnostic that decided it, then the static/dynamic
    \\split per function. A rejected program still exits 0 — the verdict is
    \\the answer, so a refusal is a result, not a crash.
    \\
    \\Flags:
    \\  --mode ts|js     strict ts (default) or dynamic js
    \\  --node           the Node platform; a built-in packages/node has not
    \\                   landed is not-yet, naming T11.6
    \\  --json           machine-readable report (used by the decision tests);
    \\                   --diagnostics=text|json spells the same choice
    \\  --bundler <b>    js mode: vite (default), none, or an adapter module
    \\
++ config_help;

/// Both commands read the file, so both list the flags that choose it.
const config_help =
    \\  --config <path>  read options from this JSON file (default:
    \\                   ./stator.config.json when it exists; docs/CONFIG.md)
    \\  --no-config      ignore stator.config.json
;

pub const Help = enum { top, build, explain };

/// The `--bundler` choice; adapters and prepared bundles exist only behind `statorc/api`.
pub const Bundler = union(enum) {
    none,
    module: struct { name: []const u8, specifier: []const u8 },

    pub const default: Bundler = .{ .module = .{ .name = "vite", .specifier = "vite-stator" } };
};

pub fn bundlerChoice(raw: []const u8) Bundler {
    if (std.mem.eql(u8, raw, "none")) return .none;
    if (std.mem.eql(u8, raw, "vite")) return Bundler.default;
    return .{ .module = .{ .name = raw, .specifier = raw } };
}

pub const Build = struct {
    entry: []const u8,
    out: []const u8,
    mode: Mode,
    emit_c: bool,
    emit_lib: bool,
    keep_c: bool,
    opt: u2,
    link_flags: []const []const u8,
    emit_header: ?[]const u8,
    unit_name: ?[]const u8,
    bundler: Bundler,
    node: bool,
};

pub const Explain = struct {
    entry: []const u8,
    mode: Mode,
    json: bool,
    bundler: Bundler,
    node: bool,
};

pub const Command = union(enum) {
    help: Help,
    version,
    build: Build,
    explain: Explain,
};

const CommandName = enum { build, explain };
const Commands = enum { both, build, explain };

const Value = struct { what: []const u8, equals: bool };

const Flag = enum { out, mode, opt, link, emit_header, unit_name, bundler, config, no_config, json, diagnostics_text, emit_c, emit_lib, emit_binary, keep_c, node };

const Spec = struct { name: []const u8, flag: Flag, commands: Commands, value: ?Value = null };

const flags = [_]Spec{
    .{ .name = "-o", .flag = .out, .commands = .build, .value = .{ .what = "an output path", .equals = false } },
    .{ .name = "--out", .flag = .out, .commands = .build, .value = .{ .what = "an output path", .equals = false } },
    .{ .name = "--mode", .flag = .mode, .commands = .both, .value = .{ .what = "a value (ts or js)", .equals = true } },
    .{ .name = "--opt", .flag = .opt, .commands = .build, .value = .{ .what = "a value (0, 1, 2, or 3)", .equals = true } },
    .{ .name = "--link", .flag = .link, .commands = .build, .value = .{ .what = "a value (clang link flags)", .equals = true } },
    .{ .name = "--emit-header", .flag = .emit_header, .commands = .build, .value = .{ .what = "a value (output header path)", .equals = true } },
    .{ .name = "--unit-name", .flag = .unit_name, .commands = .build, .value = .{ .what = "a value (C identifier prefix)", .equals = true } },
    .{ .name = "--bundler", .flag = .bundler, .commands = .both, .value = .{ .what = "a value (vite, none or a module)", .equals = true } },
    .{ .name = "--config", .flag = .config, .commands = .both, .value = .{ .what = "a value (config file path)", .equals = true } },
    .{ .name = "--no-config", .flag = .no_config, .commands = .both },
    .{ .name = "--json", .flag = .json, .commands = .explain },
    .{ .name = "--diagnostics=json", .flag = .json, .commands = .explain },
    .{ .name = "--diagnostics=text", .flag = .diagnostics_text, .commands = .explain },
    .{ .name = "--emit=c", .flag = .emit_c, .commands = .build },
    .{ .name = "--emit=lib", .flag = .emit_lib, .commands = .build },
    .{ .name = "--emit=binary", .flag = .emit_binary, .commands = .build },
    .{ .name = "--keep-c", .flag = .keep_c, .commands = .build },
    .{ .name = "--node", .flag = .node, .commands = .both },
};

fn exactFlag(name: []const u8) ?*const Spec {
    for (&flags) |*spec| if (std.mem.eql(u8, spec.name, name)) return spec;
    return null;
}

const Found = struct { name: []const u8, spec: *const Spec, inline_value: ?[]const u8 = null };

fn lookupFlag(arg: []const u8) ?Found {
    if (exactFlag(arg)) |spec| return .{ .name = arg, .spec = spec };
    const eq = std.mem.indexOfScalar(u8, arg, '=') orelse return null;
    if (!std.mem.startsWith(u8, arg, "--")) return null;
    const name = arg[0..eq];
    const spec = exactFlag(name) orelse return null;
    const value = spec.value orelse return null;
    if (!value.equals) return null;
    return .{ .name = name, .spec = spec, .inline_value = arg[eq + 1 ..] };
}

/// `-o --emit=c` is a forgotten path, not a file named `--emit=c`. A value that really starts with
/// `-` (a clang flag for `--link`) has the `--flag=value` spelling.
fn flagValue(r: *Reporter, name: []const u8, value: Value, inline_value: ?[]const u8, next: ?[]const u8) Error![]const u8 {
    const given = inline_value orelse next orelse return r.fail("STA0004", "{s} requires {s}", .{ name, value.what });
    if (given.len == 0) return r.fail("STA0004", "{s} requires {s}", .{ name, value.what });
    if (inline_value == null and given[0] == '-') {
        if (value.equals) return r.fail("STA0004", "{s} requires {s}, not the flag \"{s}\" (write {s}={s} if that is the value)", .{ name, value.what, given, name, given });
        return r.fail("STA0004", "{s} requires {s}, not the flag \"{s}\"", .{ name, value.what, given });
    }
    return given;
}

fn parseMode(r: *Reporter, raw: []const u8) Error!Mode {
    if (std.mem.eql(u8, raw, "ts")) return .ts;
    if (std.mem.eql(u8, raw, "js")) return .js;
    return r.fail("STA0002", "unknown mode \"{s}\" (expected \"ts\" or \"js\")", .{raw});
}

fn parseOpt(r: *Reporter, raw: []const u8, origin: []const u8) Error!u2 {
    if (raw.len == 1 and raw[0] >= '0' and raw[0] <= '3') return @intCast(raw[0] - '0');
    return r.fail("STA0002", "unknown opt \"{s}\"{s} (expected 0, 1, 2, or 3)", .{ raw, origin });
}

fn envOpt(r: *Reporter, raw: ?[]const u8) Error!?u2 {
    const env = raw orelse return null;
    if (env.len == 0) return null;
    return try parseOpt(r, env, " in the environment variable STATOR_OPT");
}

pub const Inputs = struct {
    cwd: []const u8,
    env_opt: ?[]const u8,
    io: std.Io,
};

pub fn parse(a: Allocator, r: *Reporter, argv: []const []const u8, inputs: Inputs) Error!Command {
    if (argv.len == 0) return .{ .help = .top };
    const head = argv[0];
    if (std.mem.eql(u8, head, "--help") or std.mem.eql(u8, head, "-h")) return .{ .help = .top };
    if (std.mem.eql(u8, head, "--version") or std.mem.eql(u8, head, "-v")) return .version;
    const command: CommandName = if (std.mem.eql(u8, head, "build"))
        .build
    else if (std.mem.eql(u8, head, "explain"))
        .explain
    else
        return r.fail("STA0003", "unknown command \"{s}\" (expected \"build\" or \"explain\")", .{head});

    var cli: config.CliOptions = .{};
    var link_flags: std.ArrayList([]const u8) = .empty;
    var choice: config.Choice = .discover;

    var i: usize = 1;
    while (i < argv.len) : (i += 1) {
        const arg = argv[i];
        if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h"))
            return .{ .help = if (command == .build) .build else .explain };
        const found = lookupFlag(arg) orelse {
            if (arg.len != 0 and arg[0] == '-') return r.fail("STA0005", "unknown flag \"{s}\"", .{arg});
            if (cli.entry != null) return r.fail("STA0006", "unexpected argument \"{s}\"", .{arg});
            cli.entry = arg;
            continue;
        };
        const applies = switch (found.spec.commands) {
            .both => true,
            .build => command == .build,
            .explain => command == .explain,
        };
        if (!applies) return r.fail("STA0005", "flag \"{s}\" does not apply to {s}", .{ arg, @tagName(command) });
        var value: []const u8 = "";
        if (found.spec.value) |spec| {
            value = try flagValue(r, found.name, spec, found.inline_value, if (i + 1 < argv.len) argv[i + 1] else null);
            if (found.inline_value == null) i += 1;
        }
        switch (found.spec.flag) {
            .out => cli.out = value,
            .mode => cli.mode = try parseMode(r, value),
            .opt => cli.opt = try parseOpt(r, value, ""),
            .link => {
                const split = config.splitFlags(a, value);
                if (split.len == 0) return r.fail("STA0004", "--link requires a value (clang link flags)", .{});
                link_flags.appendSlice(a, split) catch oom();
            },
            inline .emit_header, .unit_name, .bundler => |field| @field(cli, @tagName(field)) = value,
            .config => choice = .{ .path = value },
            .no_config => choice = .none,
            .json => cli.diagnostics = .json,
            .diagnostics_text => cli.diagnostics = .text,
            inline .emit_c, .emit_lib, .emit_binary => |emit| cli.emit = @field(config.Emit, @tagName(emit)["emit_".len..]),
            inline .keep_c, .node => |field| @field(cli, @tagName(field)) = true,
        }
    }

    // Read after the scan, so `--help` and an unknown flag never touch the file.
    cli.link = link_flags.items;
    const env_opt = try envOpt(r, inputs.env_opt);
    const loaded = try config.load(a, r, inputs.io, choice, inputs.cwd);
    const options = config.resolveOptions(a, cli, env_opt, loaded);
    const entry = options.entry orelse return r.fail("STA0004", "\"{s}\" requires an entry file", .{head});
    // A ts-mode graph never bundles: a package import there is refused at the gate, so a bundler
    // choice is a mistake worth naming, not an inert flag.
    if (options.mode == .ts and options.bundler != null) return r.fail("STA0004", "--bundler requires --mode=js", .{});
    const bundler = if (options.bundler) |b| bundlerChoice(b) else Bundler.default;
    if (command == .build) {
        const out = options.out orelse return r.fail("STA0004", "build requires -o <out>", .{});
        return .{ .build = fromOptions(Build, options, .{ .entry = entry, .out = out, .emit_c = options.emit == .c, .emit_lib = options.emit == .lib, .link_flags = options.link, .bundler = bundler }) };
    }
    return .{ .explain = fromOptions(Explain, options, .{ .entry = entry, .json = options.diagnostics == .json, .bundler = bundler }) };
}

/// A command's fields come from the resolved options under the same name unless `own` names them.
fn fromOptions(comptime T: type, options: anytype, own: anytype) T {
    var out: T = undefined;
    inline for (comptime std.meta.fieldNames(T)) |name| {
        @field(out, name) = if (@hasField(@TypeOf(own), name)) @field(own, name) else @field(options, name);
    }
    return out;
}

fn expectFailure(argv: []const []const u8, code: []const u8, message: []const u8) !void {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var r: Reporter = .{ .a = arena.allocator() };
    _ = parse(arena.allocator(), &r, argv, .{ .cwd = "/nonexistent", .env_opt = null, .io = std.testing.io }) catch {
        try std.testing.expectEqualStrings(code, r.failure.?.code);
        try std.testing.expectEqualStrings(message, r.failure.?.message);
        return;
    };
    return error.TestExpectedFailure;
}

test "usage errors carry the CLI's codes" {
    try expectFailure(&.{"nope"}, "STA0003", "unknown command \"nope\" (expected \"build\" or \"explain\")");
    try expectFailure(&.{ "build", "--what" }, "STA0005", "unknown flag \"--what\"");
    try expectFailure(&.{ "build", "a", "b" }, "STA0006", "unexpected argument \"b\"");
    try expectFailure(&.{ "explain", "-o", "x" }, "STA0005", "flag \"-o\" does not apply to explain");
    try expectFailure(&.{ "build", "a.ts", "--mode=x" }, "STA0002", "unknown mode \"x\" (expected \"ts\" or \"js\")");
    try expectFailure(&.{ "build", "a.ts", "-o" }, "STA0004", "-o requires an output path");
    try expectFailure(&.{ "build", "a.ts", "-o", "--emit=c" }, "STA0004", "-o requires an output path, not the flag \"--emit=c\"");
    try expectFailure(&.{ "build", "--opt", "-x" }, "STA0004", "--opt requires a value (0, 1, 2, or 3), not the flag \"-x\" (write --opt=-x if that is the value)");
    try expectFailure(&.{ "build", "a.ts", "--link=" }, "STA0004", "--link requires a value (clang link flags)");
    try expectFailure(&.{ "build", "a.ts" }, "STA0004", "build requires -o <out>");
    try expectFailure(&.{"explain"}, "STA0004", "\"explain\" requires an entry file");
    try expectFailure(&.{ "explain", "a.ts", "--bundler=none" }, "STA0004", "--bundler requires --mode=js");
}

test "an inline value keeps a leading dash" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var r: Reporter = .{ .a = arena.allocator() };
    const c = try parse(arena.allocator(), &r, &.{ "build", "a.ts", "-o", "b", "--link=-lm  -L/x", "--link=-ly" }, .{ .cwd = "/nonexistent", .env_opt = "1", .io = std.testing.io });
    try std.testing.expectEqual(@as(u2, 1), c.build.opt);
    try std.testing.expectEqual(@as(usize, 3), c.build.link_flags.len);
    try std.testing.expectEqualStrings("-L/x", c.build.link_flags[1]);
}

test "the environment's opt names where it came from" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var r: Reporter = .{ .a = arena.allocator() };
    try std.testing.expectError(error.Failed, parse(arena.allocator(), &r, &.{ "build", "a.ts", "-o", "b" }, .{ .cwd = "/nonexistent", .env_opt = "7", .io = std.testing.io }));
    try std.testing.expectEqualStrings("unknown opt \"7\" in the environment variable STATOR_OPT (expected 0, 1, 2, or 3)", r.failure.?.message);
}
