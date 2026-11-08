//! `stator-engine`, the engine's command line (docs/ENGINE.md §5).
//!
//!   stator-engine run [--mode=interp|jit] [--lang=js|ts|wasm] <file>
//!   stator-engine build --target=wasm|zig <file>      (plan/T67.2, plan/T67.4: not yet)
//!
//! Exit status: 0 when the script ran to the end, 1 for an uncaught exception, a syntax error or a
//! construct the engine does not run yet, 2 for a usage error.

const std = @import("std");
const Io = std.Io;
const interp = @import("stator_interp");
const engine = interp.engine;
const c = interp.rt.c;

const usage =
    \\usage: stator-engine run [--mode=interp|jit] [--lang=js|ts|wasm] <file>
    \\       stator-engine build --target=wasm|zig <file>
    \\
    \\  --mode   interp (default) runs bytecode; jit compiles each function on its first call
    \\  --lang   taken from the file's extension when absent (.js .mjs .cjs .ts .mts .cts .wasm)
    \\
;

pub fn main(init: std.process.Init) !u8 {
    const io = init.io;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len < 2) return fail(io, "", .{});
    const cmd = args[1];
    if (std.mem.eql(u8, cmd, "--help") or std.mem.eql(u8, cmd, "-h")) {
        Io.File.stdout().writeStreamingAll(io, usage) catch {};
        return 0;
    }
    if (std.mem.eql(u8, cmd, "build")) return build(io, args[2..]);
    if (!std.mem.eql(u8, cmd, "run")) return fail(io, "unknown command '{s}'\n", .{cmd});

    var mode: engine.Mode = .interp;
    var lang: ?engine.Language = null;
    var file: ?[]const u8 = null;
    for (args[2..]) |arg| {
        if (std.mem.startsWith(u8, arg, "--mode=")) {
            mode = std.meta.stringToEnum(engine.Mode, arg["--mode=".len..]) orelse return fail(io, "unknown mode '{s}'\n", .{arg["--mode=".len..]});
        } else if (std.mem.startsWith(u8, arg, "--lang=")) {
            lang = std.meta.stringToEnum(engine.Language, arg["--lang=".len..]) orelse return fail(io, "unknown language '{s}'\n", .{arg["--lang=".len..]});
        } else if (std.mem.startsWith(u8, arg, "-")) {
            return fail(io, "unknown option '{s}'\n", .{arg});
        } else if (file != null) {
            return fail(io, "one file at a time\n", .{});
        } else file = arg;
    }
    const path = file orelse return fail(io, "no file to run\n", .{});
    const language = lang orelse engine.languageOf(path) orelse return fail(io, "cannot tell the language of '{s}': pass --lang\n", .{path});
    if (mode == .jit and !interp.jit.available) eprint(io, "stator-engine: no JIT backend for this host; interpreting\n", .{});

    const a = init.arena.allocator();
    const src = Io.Dir.cwd().readFileAlloc(io, path, a, .unlimited) catch |err| {
        eprint(io, "stator-engine: cannot read '{s}': {s}\n", .{ path, @errorName(err) });
        return 1;
    };
    switch (engine.run(a, path, src, language, mode)) {
        .ok => return 0,
        .uncaught => {
            const e = c.jsrt_take_exception();
            eprint(io, "Uncaught ", .{});
            // An error prints as `TypeError: message`, the line Node starts its report with.
            c.jsrt_eprint(if (interp.rt.isObjectLike(e)) c.jsrt_to_string(e) else e);
            _ = c.jsrt_take_exception();
            return 1;
        },
        .syntax_error => |e| {
            eprint(io, "{s}: SyntaxError at offset {d}: {s}\n", .{ path, e.offset, e.message });
            return 1;
        },
        .unsupported => |what| {
            eprint(io, "{s}: not supported by the engine yet: {s}\n", .{ path, what });
            return 1;
        },
        .not_yet => |l| {
            eprint(io, "{s}: running {s} is not supported yet (plan/T67.3)\n", .{ path, @tagName(l) });
            return 1;
        },
    }
}

/// `build` names its targets so a script sees a plain refusal rather than an unknown command.
fn build(io: Io, args: []const []const u8) u8 {
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--target=wasm")) return notYet(io, "WebAssembly output", "plan/T67.2");
        if (std.mem.eql(u8, arg, "--target=zig")) return notYet(io, "Zig source output", "plan/T67.4");
    }
    return fail(io, "build needs --target=wasm or --target=zig\n", .{});
}

fn notYet(io: Io, what: []const u8, card: []const u8) u8 {
    eprint(io, "stator-engine: {s} is not supported yet ({s})\n", .{ what, card });
    return 1;
}

fn fail(io: Io, comptime fmt: []const u8, args: anytype) u8 {
    eprint(io, "stator-engine: " ++ fmt, args);
    Io.File.stderr().writeStreamingAll(io, usage) catch {};
    return 2;
}

fn eprint(io: Io, comptime fmt: []const u8, args: anytype) void {
    var buf: [1024]u8 = undefined;
    const text = std.fmt.bufPrint(&buf, fmt, args) catch return;
    Io.File.stderr().writeStreamingAll(io, text) catch {};
}
