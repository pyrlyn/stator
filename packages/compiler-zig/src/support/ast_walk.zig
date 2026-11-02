//! Walks of a subtree that only look for nodes, so each use states what it looks for and not how
//! to recurse.
const std = @import("std");
const ast = @import("stator_ts").ast;
const Node = ast.Node;

pub const Step = enum { descend, skip, match };

/// Whether a node under `root` (never `root` itself) is a `match`. `skip` leaves a node's subtree
/// unvisited; the walk stops at the first match.
pub fn contains(root: *Node, context: anytype, comptime step: fn (@TypeOf(context), *Node) Step) bool {
    const Search = struct {
        context: @TypeOf(context),
        found: bool = false,

        fn visit(s: *@This(), node: *Node) void {
            if (s.found) return;
            switch (step(s.context, node)) {
                .match => s.found = true,
                .skip => {},
                .descend => ast.forEachChild(node, s, visit),
            }
        }
    };
    var search: Search = .{ .context = context };
    ast.forEachChild(root, &search, Search.visit);
    return search.found;
}

/// What `pick` returns for each node under `root`, in source order. Every subtree is visited, the
/// picked nodes' own included.
pub fn collect(comptime T: type, a: std.mem.Allocator, root: *Node, context: anytype, comptime pick: fn (@TypeOf(context), *Node) ?T) std.mem.Allocator.Error![]T {
    const Collect = struct {
        context: @TypeOf(context),
        a: std.mem.Allocator,
        found: std.ArrayList(T) = .empty,
        failed: bool = false,

        fn visit(s: *@This(), node: *Node) void {
            if (pick(s.context, node)) |value| s.found.append(s.a, value) catch {
                s.failed = true;
            };
            ast.forEachChild(node, s, visit);
        }
    };
    var walk: Collect = .{ .context = context, .a = a };
    ast.forEachChild(root, &walk, Collect.visit);
    if (walk.failed) return error.OutOfMemory;
    return walk.found.items;
}
