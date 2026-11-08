//! What a JavaScript engine takes from stator-ts (packages/engine, plan/T67): the parser, and a
//! TypeScript file with its types erased to JavaScript. One root, so the parser's files belong to
//! one module of the engine's build.

const std = @import("std");
const ast = @import("ast.zig");
const parser = @import("parser.zig");
const binder = @import("binder.zig");
const emit = @import("emit.zig");

pub const parse = parser.parse;

pub const Erased = struct {
    file: *ast.File,
    /// Null when the file has syntax errors, which `file.diags` holds.
    js: ?[]const u8,
};

/// `path` picks the grammar (`.ts`, `.tsx`, `.mts`, …), as it does for the parser.
pub fn erase(a: std.mem.Allocator, path: []const u8, src: []const u8) Erased {
    const f = parser.parse(a, path, src);
    if (f.diags.len != 0) return .{ .file = f, .js = null };
    binder.bindFile(a, f);
    return .{ .file = f, .js = emit.emit(a, f, .{}) };
}

test "erases a TypeScript file, or keeps its syntax errors" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ok = erase(a, "t.ts", "const n: number = 1;\ninterface I { x: string }\nfunction f(x: I): void {}\n");
    try std.testing.expectEqualStrings("const n = 1;\n\nfunction f(x) {}\n", ok.js.?);
    const bad = erase(a, "t.ts", "let = ;");
    try std.testing.expect(bad.js == null and bad.file.diags.len != 0);
}
