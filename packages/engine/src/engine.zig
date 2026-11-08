//! The engine (docs/ENGINE.md): a script in one of its languages, run in one of its modes.
//!
//! Modes: `interp` is the bytecode interpreter (docs/INTERPRETER.md); `jit` compiles each
//! function on its first call through the baseline JIT (src/jit/) and interprets what it does not
//! take. Languages: JavaScript; TypeScript, whose types stator-ts erases first; WebAssembly is
//! named so the CLI can refuse it plainly until plan/T67.3 runs it.

const std = @import("std");
const rt = @import("rt.zig");
const c = rt.c;
const interp = @import("interp.zig");
const parse = @import("parse.zig");
const builtins = @import("builtins.zig");
const jit = @import("jit/jit.zig");
const stator_ts = @import("parser");
const Value = rt.Value;

pub const Mode = jit.Mode;
pub const Language = enum { js, ts, wasm };

/// The language a file's extension names, or null for one the engine does not know.
pub fn languageOf(path: []const u8) ?Language {
    const ext = std.fs.path.extension(path);
    inline for (.{ ".js", ".mjs", ".cjs" }) |e| if (std.mem.eql(u8, ext, e)) return .js;
    inline for (.{ ".ts", ".mts", ".cts" }) |e| if (std.mem.eql(u8, ext, e)) return .ts;
    if (std.mem.eql(u8, ext, ".wasm")) return .wasm;
    return null;
}

pub const Outcome = union(enum) {
    ok,
    /// An exception reached the top: it is left pending for the caller to print.
    uncaught,
    /// TypeScript that does not parse (JavaScript's syntax errors are thrown SyntaxErrors).
    syntax_error: parse.SyntaxError,
    /// A construct the interpreter does not run yet; nothing ran.
    unsupported: []const u8,
    /// A language the engine names but does not run yet.
    not_yet: Language,
};

/// Runs `src` as a script: `path` names it for TypeScript's grammar (`.ts`, `.mts`, …).
/// Microtasks run to the end, as a program's main does.
pub fn run(a: std.mem.Allocator, path: []const u8, src: []const u8, lang: Language, mode: Mode) Outcome {
    const js = switch (lang) {
        .wasm => return .{ .not_yet = .wasm },
        .js => src,
        .ts => blk: {
            const erased = stator_ts.erase(a, path, src);
            break :blk erased.js orelse return .{ .syntax_error = parse.firstDiag(erased.file).? };
        },
    };
    jit.mode = mode;
    c.jsrt_init();
    builtins.installConsole();
    switch (interp.runScript(js, false)) {
        .unsupported => |u| return .{ .unsupported = u.what },
        .value => {},
    }
    if (rt.pending()) return .uncaught;
    c.jsrt_run_microtasks();
    return if (rt.pending()) .uncaught else .ok;
}

test "languages come from the extension" {
    try std.testing.expectEqual(Language.js, languageOf("a/b.mjs").?);
    try std.testing.expectEqual(Language.ts, languageOf("b.ts").?);
    try std.testing.expectEqual(Language.wasm, languageOf("m.wasm").?);
    try std.testing.expect(languageOf("README.md") == null);
}

test "TypeScript runs after its types are erased, in both modes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const src =
        \\interface P { x: number; y: number }
        \\function len(p: P): number { return Math.sqrt(p.x * p.x + p.y * p.y); }
        \\const r: number = len({ x: 3, y: 4 });
        \\if (r !== 5) throw new Error("got " + r);
    ;
    inline for (.{ Mode.interp, Mode.jit }) |m| {
        try std.testing.expectEqual(Outcome.ok, run(arena.allocator(), "t.ts", src, .ts, m));
    }
    jit.mode = .interp;
}

test "an uncaught exception and a syntax error are reported, WebAssembly is not yet" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expectEqual(Outcome.uncaught, run(a, "t.js", "throw 1", .js, .jit));
    _ = c.jsrt_take_exception();
    try std.testing.expect(run(a, "t.ts", "let x: = ;", .ts, .interp) == .syntax_error);
    try std.testing.expect(run(a, "m.wasm", "", .wasm, .interp) == .not_yet);
    jit.mode = .interp;
}
