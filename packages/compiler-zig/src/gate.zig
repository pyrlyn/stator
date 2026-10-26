//! The unsupported-constructs gate, syntactic half (docs/zig-core.md "Gate parity").
//! Walks the flat Oxc node list and reports the same STA codes and messages as
//! packages/compiler/src/frontend/gate.ts for every rule decidable from syntax alone.
//! Type-directed rules wait for the tsgo type checker (phase 3).

const std = @import("std");
const oxc = @import("oxc.zig");

pub const Mode = enum { ts, js };
pub const Options = struct { mode: Mode = .ts, node: bool = false };
pub const Finding = struct { code: []const u8, start: u32, message: []const u8 };

pub const msg = struct {
    pub const js_in_ts = ".js files are not allowed in ts mode; use `--mode=js` or convert to .ts";
    pub const eval_ts = "eval() is not allowed in ts mode — it prevents static analysis and is a permanent design choice";
    pub const new_function_ts = "new Function() is not allowed in ts mode — code generation is not supported";
    pub const eval_js = "eval() and new Function() are not yet supported in js mode; planned for Phase 8 (dynamic tier)";
    pub const var_ts = "var is not allowed in ts mode; use let or const instead";
    pub const arguments_ts = "arguments pseudo-variable is not allowed in ts mode; use rest parameters instead";
    pub const arguments_js = "arguments pseudo-variable is not yet supported in js mode; planned for Phase 5 (stretch goal)";
    pub const proxy_ts = "Proxy is not supported in ts mode — metaprogramming is outside the static compilation model";
    pub const proxy_js = "Proxy is not yet supported in js mode; planned for Phase 8 (dynamic tier)";
    pub const with = "with statement is not supported — ESM is strict; with is not allowed in strict mode";
    pub const decorator = "decorators are not supported in v1";
    pub const extensionless = "a relative import must name the file's extension (./x.ts, ./x.js) — Node ESM does not resolve extensionless specifiers";
    pub const generator = "generators are not yet supported; planned for Phase 5 (the iterator protocol)";
    pub const dynamic_import = "import() with a computed specifier is not yet supported; planned for Phase 8 (runtime module resolution)";
    pub const symbol = "Symbol is not yet supported; planned for Phase 5";
    pub const bigint = "BigInt is not yet supported; planned for Phase 5";
    pub const cjs_ts = " is not supported — ts mode uses ES modules only";
    pub const cjs_js = " is not supported — without --node, Stator uses ES modules only";
};

const Ctx = struct {
    ast: oxc.Ast,
    src: []const u8,
    nodes: []const oxc.Node,
    opts: Options,
    out: *std.ArrayList(Finding),
    gpa: std.mem.Allocator,

    fn kind(c: Ctx, i: usize) []const u8 {
        return c.ast.kindName(c.nodes[i].kind);
    }
    fn is(c: Ctx, i: usize, k: []const u8) bool {
        return std.mem.eql(u8, c.kind(i), k);
    }
    fn text(c: Ctx, i: usize) []const u8 {
        const n = c.nodes[i];
        return c.src[@min(n.start, c.src.len)..@min(n.end, c.src.len)];
    }
    /// The first child in pre-order, or null.
    fn child(c: Ctx, i: usize) ?usize {
        if (i + 1 < c.nodes.len and c.nodes[i + 1].parent == i) return i + 1;
        return null;
    }
    fn parentOf(c: Ctx, i: usize) ?usize {
        const p = c.nodes[i].parent;
        return if (p == oxc.no_parent) null else p;
    }
    fn add(c: Ctx, code: []const u8, i: usize, message: []const u8) !void {
        try c.out.append(c.gpa, .{ .code = code, .start = c.nodes[i].start, .message = message });
    }
    fn calleeIs(c: Ctx, i: usize, name: []const u8) bool {
        const f = c.child(i) orelse return false;
        return c.is(f, "IdentifierReference") and std.mem.eql(u8, c.text(f), name);
    }
};

fn endsWithAny(s: []const u8, exts: []const []const u8) bool {
    for (exts) |e| if (std.mem.endsWith(u8, s, e)) return true;
    return false;
}

/// Gate one parsed file. Findings are appended in source order of discovery.
pub fn gate(gpa: std.mem.Allocator, path: []const u8, src: []const u8, ast: oxc.Ast, opts: Options, out: *std.ArrayList(Finding)) !void {
    const c = Ctx{ .ast = ast, .src = src, .nodes = ast.nodes(), .opts = opts, .out = out, .gpa = gpa };
    const ts = opts.mode == .ts;
    if (ts and endsWithAny(path, &.{ ".js", ".cjs", ".mjs", ".jsx" })) {
        try out.append(gpa, .{ .code = "STA1002", .start = 0, .message = msg.js_in_ts });
        return;
    }
    for (c.nodes, 0..) |_, i| {
        if (c.is(i, "Decorator")) {
            try c.add("STA1112", i, msg.decorator);
        } else if (c.is(i, "WithStatement")) {
            try c.add("STA1109", i, msg.with);
        } else if (c.is(i, "BigIntLiteral")) {
            try c.add("STA1213", i, msg.bigint);
        } else if (c.is(i, "VariableDeclaration") and ts and std.mem.startsWith(u8, c.text(i), "var")) {
            try c.add("STA1104", i, msg.var_ts);
        } else if (c.is(i, "CallExpression")) {
            if (c.calleeIs(i, "eval")) {
                try c.add(if (ts) "STA1101" else "STA1206", i, if (ts) msg.eval_ts else msg.eval_js);
            } else if (c.calleeIs(i, "Symbol")) {
                try c.add("STA1212", i, msg.symbol);
            } else if (c.calleeIs(i, "require") and (ts or !opts.node)) {
                try c.add("STA1110", i, if (ts) "CommonJS require()" ++ msg.cjs_ts else "CommonJS require()" ++ msg.cjs_js);
            }
        } else if (c.is(i, "NewExpression")) {
            if (c.calleeIs(i, "Function")) {
                try c.add(if (ts) "STA1103" else "STA1206", i, if (ts) msg.new_function_ts else msg.eval_js);
            } else if (c.calleeIs(i, "Proxy")) {
                try c.add(if (ts) "STA1106" else "STA1203", i, if (ts) msg.proxy_ts else msg.proxy_js);
            }
        } else if (c.is(i, "IdentifierReference")) {
            const name = c.text(i);
            if (std.mem.eql(u8, name, "arguments")) {
                try c.add(if (ts) "STA1105" else "STA1202", i, if (ts) msg.arguments_ts else msg.arguments_js);
            } else if ((ts or !opts.node) and std.mem.eql(u8, name, "module")) {
                const p = c.parentOf(i);
                if (p != null and c.is(p.?, "StaticMemberExpression") and std.mem.endsWith(u8, c.text(p.?), ".exports"))
                    try c.add("STA1110", i, if (ts) "CommonJS module.exports" ++ msg.cjs_ts else "CommonJS module.exports" ++ msg.cjs_js);
            } else if ((ts or !opts.node) and (std.mem.eql(u8, name, "__filename") or std.mem.eql(u8, name, "__dirname"))) {
                try c.add("STA1110", i, if (ts) "CommonJS __filename/__dirname" ++ msg.cjs_ts else "CommonJS __filename/__dirname" ++ msg.cjs_js);
            }
        } else if (c.is(i, "ImportExpression")) {
            const s = c.child(i);
            if (s == null or !c.is(s.?, "StringLiteral")) try c.add("STA1207", i, msg.dynamic_import);
        } else if (c.is(i, "ForOfStatement") and std.mem.startsWith(u8, c.text(i), "for await")) {
            try c.add("STA1201", i, msg.generator);
        } else if (c.is(i, "Function") and std.mem.startsWith(u8, c.text(i), "async function*")) {
            try c.add("STA1201", i, msg.generator);
        } else if (c.is(i, "ImportDeclaration") or c.is(i, "ExportNamedDeclaration") or c.is(i, "ExportAllDeclaration")) {
            // The specifier is the direct StringLiteral child.
            var j = i + 1;
            while (j < c.nodes.len and c.nodes[j].start < c.nodes[i].end) : (j += 1) {
                if (c.nodes[j].parent != i or !c.is(j, "StringLiteral")) continue;
                const t = c.text(j);
                if (t.len < 2) break;
                const spec = t[1 .. t.len - 1];
                const relative = std.mem.startsWith(u8, spec, "./") or std.mem.startsWith(u8, spec, "../");
                const base = spec[(std.mem.lastIndexOfScalar(u8, spec, '/') orelse 0)..];
                if (relative and std.mem.indexOfScalar(u8, base, '.') == null) try c.add("STA1113", j, msg.extensionless);
                break;
            }
        }
    }
}

fn run(path: []const u8, src: []const u8, opts: Options) !std.ArrayList(Finding) {
    const ast = try oxc.parse(path, src);
    defer ast.deinit();
    var out: std.ArrayList(Finding) = .empty;
    try gate(std.testing.allocator, path, src, ast, opts, &out);
    return out;
}

fn expectCodes(path: []const u8, src: []const u8, opts: Options, want: []const []const u8) !void {
    var out = try run(path, src, opts);
    defer out.deinit(std.testing.allocator);
    try std.testing.expectEqual(want.len, out.items.len);
    for (want, out.items) |w, f| try std.testing.expectEqualStrings(w, f.code);
}

test "ts-mode never rules" {
    try expectCodes("a.ts", "var x = 1; eval('1'); new Function('');", .{}, &.{ "STA1104", "STA1101", "STA1103" });
    try expectCodes("a.ts", "function f() { return arguments; }", .{}, &.{"STA1105"});
    try expectCodes("a.ts", "new Proxy({}, {});", .{}, &.{"STA1106"});
    try expectCodes("a.ts", "@d class A {}", .{}, &.{"STA1112"});
    try expectCodes("a.js", "const x = 1;", .{}, &.{"STA1002"});
}

test "js-mode not-yet rules and --node" {
    const js: Options = .{ .mode = .js };
    try expectCodes("a.js", "var x = 1; eval('1'); new Proxy({}, {});", js, &.{ "STA1206", "STA1203" });
    try expectCodes("a.js", "with (o) {}", js, &.{"STA1109"});
    try expectCodes("a.js", "module.exports = require('./b.js');", js, &.{ "STA1110", "STA1110" });
    try expectCodes("a.js", "module.exports = require('./b.js');", .{ .mode = .js, .node = true }, &.{});
    try expectCodes("a.js", "const b = 1n; Symbol('s');", js, &.{ "STA1213", "STA1212" });
    try expectCodes("a.js", "import a from './a'; import b from './b.js'; import('x' + y);", js, &.{ "STA1113", "STA1207" });
    try expectCodes("a.js", "async function* g() {} for await (const q of z) {}", js, &.{ "STA1201", "STA1201" });
}

test "constructs the TS compiler now supports pass" {
    // feat/realworld-gate-pass (docs/VALUE.md §4.27): builtin values, call/apply, satisfies,
    // for-of over an existing binding, Number.isFinite.
    const js: Options = .{ .mode = .js };
    try expectCodes("a.js", "var has = Object.prototype.hasOwnProperty; has.call(o, 'k'); x.constructor === Date; [].filter(Boolean); let v; for (v of [1]) {} Number.isFinite(1);", js, &.{});
    try expectCodes("a.ts", "const o = { a: 1 } satisfies Record<string, number>; ArrayBuffer.isView(o);", .{}, &.{});
}
