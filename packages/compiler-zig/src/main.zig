//! `statorc-zig`: development CLI for the Zig core (docs/zig-core.md).
//!   statorc-zig parse <file>        summary, diagnostics and an indented AST dump
//!   statorc-zig check [opts] <files...>  parse + gate every file; print failures; exit 1 if any
//!   statorc-zig gate [opts] <files...>   gate only (syntax errors still fail); one line per finding
//!   opts: --mode=ts|js (default ts), --node

const std = @import("std");
const core = @import("stator_core");
const oxc = core.oxc;
const gate = core.gate;

fn usage() noreturn {
    std.debug.print("usage: statorc-zig parse <file> | statorc-zig (check|gate) [--mode=ts|js] [--node] <files...>\n", .{});
    std.process.exit(2);
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len < 3) usage();
    var buf: [64 * 1024]u8 = undefined;
    var stdout = std.Io.File.stdout().writer(io, &buf);
    const w = &stdout.interface;
    if (std.mem.eql(u8, args[1], "parse")) {
        if (args.len != 3) usage();
        const source = try std.Io.Dir.cwd().readFileAlloc(io, args[2], gpa, .limited(64 << 20));
        defer gpa.free(source);
        const ast = try oxc.parse(args[2], source);
        defer ast.deinit();
        try dump(ast, w, gpa);
    } else if (std.mem.eql(u8, args[1], "check") or std.mem.eql(u8, args[1], "gate")) {
        const gate_only = std.mem.eql(u8, args[1], "gate");
        var opts: gate.Options = .{};
        var ok: usize = 0;
        var bad: usize = 0;
        var nodes: usize = 0;
        var findings_total: usize = 0;
        for (args[2..]) |path| {
            if (std.mem.eql(u8, path, "--mode=js")) {
                opts.mode = .js;
                continue;
            } else if (std.mem.eql(u8, path, "--mode=ts")) {
                opts.mode = .ts;
                continue;
            } else if (std.mem.eql(u8, path, "--node")) {
                opts.node = true;
                continue;
            }
            const source = try std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(64 << 20));
            defer gpa.free(source);
            const ast = oxc.parse(path, source) catch {
                try w.print("FAIL {s}: invalid UTF-8\n", .{path});
                bad += 1;
                continue;
            };
            defer ast.deinit();
            nodes += ast.nodes().len;
            if (ast.diagCount() != 0) {
                bad += 1;
                const d = ast.diag(0);
                try w.print("FAIL {s}:{d}: {s} ({d} diagnostics)\n", .{ path, d.start, d.message, ast.diagCount() });
                continue;
            }
            var findings: std.ArrayList(gate.Finding) = .empty;
            defer findings.deinit(gpa);
            try gate.gate(gpa, path, source, ast, opts, &findings);
            if (findings.items.len == 0) {
                ok += 1;
                continue;
            }
            bad += 1;
            findings_total += findings.items.len;
            for (findings.items) |f| {
                const lc = lineCol(source, f.start);
                try w.print("{s}:{d}:{d} {s} [{s}] {s}\n", .{ path, lc[0], lc[1], f.code, @tagName(opts.mode), f.message });
            }
        }
        if (gate_only)
            try w.print("{d} passed the gate, {d} blocked ({d} findings)\n", .{ ok, bad, findings_total })
        else
            try w.print("{d} ok, {d} failed, {d} nodes, {d} gate findings\n", .{ ok, bad, nodes, findings_total });
        try w.flush();
        if (bad != 0) std.process.exit(1);
    } else usage();
    try w.flush();
}

fn dump(ast: oxc.Ast, w: *std.Io.Writer, gpa: std.mem.Allocator) !void {
    const s = ast.stats();
    try w.print("nodes {d}  kinds {d}  scopes {d}  symbols {d}  references {d}  parse_errors {d}  semantic_errors {d}{s}\n", .{
        s.nodes,                                   ast.kindCount(), s.scopes, s.symbols, s.references, s.parse_errors, s.semantic_errors,
        if (s.panicked != 0) "  PANICKED" else "",
    });
    var i: u32 = 0;
    while (i < ast.diagCount()) : (i += 1) {
        const d = ast.diag(i);
        try w.print("error {d}..{d}: {s}\n", .{ d.start, d.end, d.message });
    }
    const ns = ast.nodes();
    const depth = try gpa.alloc(u32, ns.len);
    defer gpa.free(depth);
    for (ns, 0..) |n, k| {
        depth[k] = if (n.parent == oxc.no_parent) 0 else depth[n.parent] + 1;
        try w.splatByteAll(' ', depth[k] * 2);
        try w.print("{s} {d}..{d}\n", .{ ast.kindName(n.kind), n.start, n.end });
    }
}

fn lineCol(src: []const u8, offset: u32) [2]usize {
    var line: usize = 1;
    var col: usize = 1;
    for (src[0..@min(offset, src.len)]) |ch| {
        if (ch == '\n') {
            line += 1;
            col = 1;
        } else col += 1;
    }
    return .{ line, col };
}
