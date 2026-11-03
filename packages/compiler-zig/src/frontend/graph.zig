//! The module graph: which files the program is, and in what order their initialization runs. The
//! whole-program merge happens in the lowering; this decides membership and order, and refuses a
//! cycle of value imports (STA3001).
const std = @import("std");
const Allocator = std.mem.Allocator;
const stator_ts = @import("stator_ts");
const ast = stator_ts.ast;
const project = stator_ts.project;
const support = @import("../support/root.zig");
const Diagnostic = support.diagnostics.Diagnostic;
const Mode = support.diagnostics.Mode;
const Node = ast.Node;
const SourceFile = project.SourceFile;

fn oom() noreturn {
    @panic("out of memory");
}

pub const ModuleOrder = struct {
    /// Dependencies first.
    order: []const *SourceFile,
    diagnostics: []const Diagnostic,
};

const Edge = struct { target: *SourceFile, at: *Node };

const Walk = struct {
    a: Allocator,
    prog: *project.Program,
    mode: Mode,
    diagnostics: std.ArrayList(Diagnostic) = .empty,
    order: std.ArrayList(*SourceFile) = .empty,
    done: std.AutoHashMapUnmanaged(*SourceFile, void) = .empty,
    /// The current DFS path: an edge back into it is a cycle, and the list is the cycle's spelling.
    path: std.ArrayList(*SourceFile) = .empty,

    fn onPath(w: *const Walk, sf: *SourceFile) ?usize {
        return std.mem.indexOfScalar(*SourceFile, w.path.items, sf);
    }

    /// The call stack is bounded by the import depth of files already parsed.
    fn visit(w: *Walk, sf: *SourceFile) void {
        if (w.done.contains(sf)) return;
        w.path.append(w.a, sf) catch oom();
        for (valueImports(w.a, w.prog, sf)) |edge| {
            if (w.onPath(edge.target)) |from| {
                w.cycle(sf, edge, from);
                continue;
            }
            w.visit(edge.target);
        }
        _ = w.path.pop();
        w.done.put(w.a, sf, {}) catch oom();
        w.order.append(w.a, sf) catch oom();
    }

    fn cycle(w: *Walk, sf: *SourceFile, edge: Edge, from: usize) void {
        var message: std.ArrayList(u8) = .empty;
        message.appendSlice(w.a, "import cycle detected: ") catch oom();
        for (w.path.items[from..]) |step| message.print(w.a, "{s} → ", .{step.file.path}) catch oom();
        message.appendSlice(w.a, edge.target.file.path) catch oom();
        const file = sf.file;
        const d = support.diagnostics.fromRange(file.path, file.src, edge.at.start, edge.at.end, "STA3001", .@"error", w.mode, message.items, null);
        w.diagnostics.append(w.a, d) catch oom();
    }
};

pub fn moduleOrder(a: Allocator, prog: *project.Program, entry: *SourceFile, mode: Mode) ModuleOrder {
    var walk: Walk = .{ .a = a, .prog = prog, .mode = mode };
    walk.visit(entry);
    return .{ .order = walk.order.items, .diagnostics = walk.diagnostics.items };
}

const Edges = struct {
    a: Allocator,
    prog: *project.Program,
    sf: *SourceFile,
    list: std.ArrayList(Edge) = .empty,

    /// A `declare module` answers first, as the checker's lookup does, and it declares no file.
    fn push(e: *Edges, specifier: *Node, at: *Node) void {
        if (specifier.data != .string_lit) return;
        const name = specifier.data.string_lit;
        if (e.prog.ambient.contains(name)) return;
        for (e.sf.file.module_specs, e.sf.resolved) |spec, target| {
            if (!std.mem.eql(u8, spec.data.string_lit, name)) continue;
            const file = target orelse return;
            // stator-ts parses JSON as a declaration of its value; to the graph it is a module.
            const declaration = file.file.is_dts and !std.mem.endsWith(u8, file.file.path, ".json");
            if (!declaration) e.list.append(e.a, .{ .target = file, .at = at }) catch oom();
            return;
        }
    }

    fn collectCalls(e: *Edges, n: *Node) void {
        if (n.data == .call) {
            const call = n.data.call;
            if (call.callee.data == .import_kw and call.args.len > 0) e.push(call.args[0], n);
        }
        ast.forEachChild(n, e, collectCalls);
    }
};

/// Declaration order, because that is the order the imports evaluate in. A dynamic `import()`
/// counts: a cycle through one still needs its module initialized.
fn valueImports(a: Allocator, prog: *project.Program, sf: *SourceFile) []const Edge {
    var edges: Edges = .{ .a = a, .prog = prog, .sf = sf };
    for (sf.file.root.data.source_file.stmts) |statement| switch (statement.data) {
        .import_decl => |x| {
            if (x.clause) |clause| if (clause.data.import_clause.type_only) continue;
            edges.push(x.specifier, statement);
        },
        .export_decl => |x| {
            if (x.type_only) continue;
            if (x.specifier) |specifier| edges.push(specifier, statement);
        },
        else => edges.collectCalls(statement),
    };
    return edges.list.items;
}
