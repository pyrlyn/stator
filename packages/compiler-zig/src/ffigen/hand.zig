//! Every `declare function` of a hand-written binding (`readHandwritten`, `ffi-gen/diff.ts`), which
//! is parsed, never checked. The file is loaded under a directory that does not exist, so what it
//! imports or references is not read: the report describes this one file.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const fspath = std.fs.path;
const stator_ts = @import("stator_ts");
const ast = stator_ts.ast;
const project = stator_ts.project;
const pool = stator_ts.pool;
const diff = @import("diff.zig");
const jsdoc = @import("jsdoc.zig");
const text = @import("text.zig");
const HandFunction = diff.HandFunction;
const Node = ast.Node;
const oom = text.oom;

const scripts = [_][]const u8{ ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json" };

/// `createSourceFile` reads an unknown extension as TypeScript, and stator-ts goes by the path.
fn virtualPath(a: Allocator, file_name: []const u8) []const u8 {
    const base = fspath.basename(file_name);
    for (scripts) |extension| {
        if (std.mem.endsWith(u8, base, extension)) return std.fmt.allocPrint(a, "/ffi-gen-hand/{s}", .{base}) catch oom();
    }
    return std.fmt.allocPrint(a, "/ffi-gen-hand/{s}.ts", .{base}) catch oom();
}

/// A type the parser had to invent spans nothing, and may end before it starts.
fn spanText(src: []const u8, n: *const Node) []const u8 {
    return if (n.start < n.end and n.end <= src.len) src[n.start..n.end] else "";
}

fn typeText(a: Allocator, src: []const u8, node: ?*Node) []const u8 {
    return text.collapseSpaces(a, spanText(src, node orelse return "?"));
}

pub fn readHandwritten(a: Allocator, io: Io, source: []const u8, file_name: []const u8) []const HandFunction {
    const path = virtualPath(a, file_name);
    var overlay: project.Overlay = .empty;
    overlay.put(a, path, source) catch oom();
    const cfg: project.Config = .{ .root = "/ffi-gen-hand" };
    var workers = pool.ThreadPool.init(1);
    const program = project.loadProgram(a, io, &workers, &cfg, &.{path}, .{ .want_libs = false, .overlay = &overlay });
    var found: std.ArrayList(HandFunction) = .empty;
    for (program.files.items) |entry| {
        if (!std.mem.eql(u8, entry.file.path, path)) continue;
        const src = entry.file.src;
        const stmts = entry.file.root.data.source_file.stmts;
        for (stmts, 0..) |stmt, index| {
            const func = stmt.func() orelse continue;
            if (func.kind != .decl) continue;
            // Only `export default` leaves a function unnamed; elsewhere the name is a missing one.
            if (func.name == null and stmt.mods.default) continue;
            const pos: usize = if (index == 0) 0 else stmts[index - 1].end;
            const body = jsdoc.lastJsdoc(src, pos, stmt.end) orelse continue;
            const word = switch (jsdoc.externMarker(a, body)) {
                .none => continue,
                .tag => |word| word,
            };
            const ts_name = if (func.name) |name| spanText(src, name) else "";
            const params = a.alloc([]const u8, func.params.len) catch oom();
            for (func.params, params) |param, *out| {
                out.* = if (param.data == .param) typeText(a, src, param.data.param.type) else "?";
            }
            found.append(a, .{ .ts_name = ts_name, .c_name = word orelse ts_name, .param_types = params, .ret_type = typeText(a, src, func.ret) }) catch oom();
        }
    }
    return found.items;
}
