//! Zig side of the Oxc bridge (`oxc-bridge/`, docs/zig-core.md). `parse` hands a source file to
//! `oxc_parser` + `oxc_semantic` through the C ABI and returns a handle over flat copies of the
//! AST nodes (pre-order), diagnostics and scope/symbol/reference counts.

const std = @import("std");

pub const Node = extern struct { kind: u32, parent: u32, start: u32, end: u32 };
pub const no_parent: u32 = std.math.maxInt(u32);

pub const Stats = extern struct {
    nodes: u32,
    scopes: u32,
    symbols: u32,
    references: u32,
    parse_errors: u32,
    semantic_errors: u32,
    panicked: u32,
};

const Raw = opaque {};
extern fn stator_oxc_parse(path: [*]const u8, path_len: usize, src: [*]const u8, src_len: usize) ?*Raw;
extern fn stator_oxc_free(r: *Raw) void;
extern fn stator_oxc_stats(r: *const Raw) Stats;
extern fn stator_oxc_nodes(r: *const Raw, len: *usize) [*]const Node;
extern fn stator_oxc_kind_count(r: *const Raw) u32;
extern fn stator_oxc_kind_name(r: *const Raw, kind: u32, len: *usize) [*]const u8;
extern fn stator_oxc_diag_count(r: *const Raw) u32;
extern fn stator_oxc_diag(r: *const Raw, i: u32, start: *u32, end: *u32, len: *usize) [*]const u8;

pub const Diag = struct { start: u32, end: u32, message: []const u8 };

pub const Ast = struct {
    raw: *Raw,

    pub fn deinit(self: Ast) void {
        stator_oxc_free(self.raw);
    }
    pub fn stats(self: Ast) Stats {
        return stator_oxc_stats(self.raw);
    }
    pub fn nodes(self: Ast) []const Node {
        var n: usize = 0;
        const p = stator_oxc_nodes(self.raw, &n);
        return p[0..n];
    }
    pub fn kindCount(self: Ast) u32 {
        return stator_oxc_kind_count(self.raw);
    }
    pub fn kindName(self: Ast, kind: u32) []const u8 {
        var n: usize = 0;
        const p = stator_oxc_kind_name(self.raw, kind, &n);
        return p[0..n];
    }
    pub fn diagCount(self: Ast) u32 {
        return stator_oxc_diag_count(self.raw);
    }
    pub fn diag(self: Ast, i: u32) Diag {
        var s: u32 = 0;
        var e: u32 = 0;
        var n: usize = 0;
        const p = stator_oxc_diag(self.raw, i, &s, &e, &n);
        return .{ .start = s, .end = e, .message = p[0..n] };
    }
};

/// `path` selects the dialect only (`.ts`, `.tsx`, `.js`, `.d.ts`, …).
pub fn parse(path: []const u8, source: []const u8) error{InvalidUtf8}!Ast {
    const raw = stator_oxc_parse(path.ptr, path.len, source.ptr, source.len) orelse return error.InvalidUtf8;
    return .{ .raw = raw };
}

fn countKind(ast: Ast, name: []const u8) usize {
    var c: usize = 0;
    for (ast.nodes()) |n| {
        if (std.mem.eql(u8, ast.kindName(n.kind), name)) c += 1;
    }
    return c;
}

test "parses TypeScript with scopes and symbols" {
    const src =
        \\interface P { x: number }
        \\function f<T>(a: T, p: P): number { const y = p.x; return y; }
        \\export class C { #n = 1; get n(): number { return this.#n; } }
    ;
    const ast = try parse("a.ts", src);
    defer ast.deinit();
    const s = ast.stats();
    try std.testing.expectEqual(@as(u32, 0), s.parse_errors + s.semantic_errors);
    try std.testing.expectEqual(@as(u32, 0), s.panicked);
    try std.testing.expect(s.symbols >= 6); // P, f, T, a, p, y, C
    try std.testing.expect(s.scopes >= 4);
    try std.testing.expectEqual(@as(usize, 2), countKind(ast, "Function")); // f and the getter
    try std.testing.expectEqual(@as(usize, 1), countKind(ast, "Class"));
    try std.testing.expectEqual(@as(usize, 1), countKind(ast, "TSInterfaceDeclaration"));
    const ns = ast.nodes();
    try std.testing.expectEqualStrings("Program", ast.kindName(ns[0].kind));
    try std.testing.expectEqual(no_parent, ns[0].parent);
    for (ns[1..]) |n| try std.testing.expect(n.parent < ns.len and n.start <= n.end);
}

test "reports syntax errors with spans" {
    const ast = try parse("b.ts", "let x = ;\nconst y;");
    defer ast.deinit();
    try std.testing.expect(ast.diagCount() >= 1);
    const d = ast.diag(0);
    try std.testing.expect(d.message.len > 0 and d.end >= d.start);
}

test "rejects invalid UTF-8" {
    try std.testing.expectError(error.InvalidUtf8, parse("c.ts", "\xff\xfe"));
}
