//! Which functions need a closure environment and how far each reference climbs to reach it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const api = @import("../frontend/gate_api.zig");
const gate = @import("../frontend/gate.zig");
const gate_types = @import("../frontend/gate_types.zig");
const ast = api.ast;
const Gate = api.Gate;
const Node = api.Node;
const oom = api.oom;

pub const RECEIVER_NAME = " this";

pub const EnvCapture = struct {
    name: []const u8,
    decl: ?*Node,
    levels: u32,
    index: u32,
};

pub const CaptureInfo = struct {
    env_vars: []const []const u8,
    env_decls: []const ?*Node,
    captures: []const EnvCapture,
    needs_env: bool,
};

pub const CaptureMap = std.AutoHashMapUnmanaged(*Node, CaptureInfo);

pub const isFunctionLike = api.hasOwnBody;
const isArrow = api.isArrowFunction;

fn enclosingThisOwner(node: *Node) ?*Node {
    var saw_arrow = false;
    var current = node.parent;
    while (current) |c| : (current = c.parent) {
        if (isArrow(c)) {
            saw_arrow = true;
            continue;
        }
        if (isFunctionLike(c)) return c;
        if (saw_arrow and c.data == .property_decl and c.parent != null and c.parent.?.data == .class and !gate_types.isStaticMember(c)) return c.parent;
        if (c.data == .source_file) return null;
    }
    return null;
}

pub fn enclosingFunction(node: *const Node) ?*Node {
    return nearestScope(node, false);
}

/// A class is a scope too: its members see the class's own bindings.
fn enclosingScope(node: *const Node) ?*Node {
    return nearestScope(node, true);
}

fn nearestScope(node: *const Node, comptime or_class: bool) ?*Node {
    var current = node.parent;
    while (current) |c| : (current = c.parent) {
        if (isFunctionLike(c) or (or_class and c.data == .class)) return c;
        if (c.data == .source_file) return null;
    }
    return null;
}

fn isCapturableDeclaration(decl: *const Node) bool {
    return decl.data == .var_decl or decl.data == .param or api.isFunctionDeclaration(decl);
}

fn declarationName(decl: *const Node) ?[]const u8 {
    const name = switch (decl.data) {
        .func => |x| x.name orelse return null,
        .var_decl => |x| x.name,
        .param => |x| x.name,
        else => return null,
    };
    return if (name.data == .identifier) name.data.identifier else null;
}

pub fn loopScopeOf(decl: *const Node) ?*Node {
    var current = decl.parent;
    while (current) |n| : (current = n.parent) {
        if (isFunctionLike(n)) return null;
        if (api.isIterationStatement(n)) return n;
    }
    return null;
}

fn isPerIterationBinding(decl: *const Node) bool {
    if (decl.data != .var_decl) return false;
    const list = decl.parent orelse return false;
    if (list.data != .var_list) return false;
    return list.data.var_list.kind != .@"var" and loopScopeOf(decl) != null;
}

const Owned = std.AutoArrayHashMapUnmanaged(?*Node, []const u8);

const Reference = struct {
    ref: *Node,
    decl_fn: *Node,
    name: []const u8,
    decl: ?*Node,
};

const Walk = struct {
    a: Allocator,
    g: *Gate,
    source: *Node,
    captured: std.AutoArrayHashMapUnmanaged(*Node, Owned) = .empty,
    references: std.ArrayList(Reference) = .empty,

    fn own(w: *Walk, owner: *Node) *Owned {
        const entry = w.captured.getOrPut(w.a, owner) catch oom();
        if (!entry.found_existing) entry.value_ptr.* = .empty;
        return entry.value_ptr;
    }

    fn visit(w: *Walk, node: *Node) void {
        if (node.data == .this_expr or node.data == .super_expr) {
            if (enclosingThisOwner(node)) |owner| {
                if (owner != enclosingFunction(node)) {
                    w.own(owner).put(w.a, null, RECEIVER_NAME) catch oom();
                    w.references.append(w.a, .{ .ref = node, .decl_fn = owner, .name = RECEIVER_NAME, .decl = null }) catch oom();
                    if (owner.data == .class) {
                        for (owner.data.class.members) |m| {
                            if (m.data == .func and m.data.func.kind == .ctor and m.data.func.body != null) {
                                w.own(m).put(w.a, null, RECEIVER_NAME) catch oom();
                                break;
                            }
                        }
                    }
                }
            }
        }
        if (node.data == .identifier) {
            if (gate_types.isClassAliasUse(w.g, node)) return;
            if (w.g.symbolAt(node)) |symbol| if (symbol.value_decl) |decl| {
                if (isCapturableDeclaration(decl) and api.declarationName(decl) != node) {
                    const enclosing = enclosingFunction(decl);
                    const decl_fn = enclosing orelse (if (isPerIterationBinding(decl)) w.source else null);
                    if (decl_fn != null and enclosingFunction(node) != enclosing) if (declarationName(decl)) |name| {
                        w.own(decl_fn.?).put(w.a, decl, name) catch oom();
                        w.references.append(w.a, .{ .ref = node, .decl_fn = decl_fn.?, .name = name, .decl = decl }) catch oom();
                    };
                }
            };
        }
        ast.forEachChild(node, w, visit);
    }
};

const Collect = struct {
    fn record(c: *@This(), n: *Node) void {
        c.result.put(c.a, n, .{
            .env_vars = c.env_vars.get(n) orelse &.{},
            .env_decls = c.env_decls.get(n) orelse &.{},
            .captures = if (c.captures_of.getPtr(n)) |own| own.values() else &.{},
            .needs_env = c.needs_env.contains(n),
        }) catch oom();
    }

    fn visit(c: *@This(), n: *Node) void {
        if (isFunctionLike(n) or n.data == .class) c.record(n);
        ast.forEachChild(n, c, visit);
    }

    a: Allocator,
    result: *CaptureMap,
    env_vars: *const std.AutoHashMapUnmanaged(*Node, []const []const u8),
    env_decls: *const std.AutoHashMapUnmanaged(*Node, []const ?*Node),
    captures_of: *std.AutoHashMapUnmanaged(*Node, std.StringArrayHashMapUnmanaged(EnvCapture)),
    needs_env: *const std.AutoHashMapUnmanaged(*Node, void),
};

const Entry = struct { decl: ?*Node, name: []const u8 };

fn entryLess(_: void, x: Entry, y: Entry) bool {
    return switch (std.mem.order(u8, x.name, y.name)) {
        .lt => true,
        .gt => false,
        .eq => (if (x.decl) |d| @as(i64, d.start) else -1) < (if (y.decl) |d| @as(i64, d.start) else -1),
    };
}

pub fn analyzeCaptures(a: Allocator, g: *Gate, source: *Node) *CaptureMap {
    var walk: Walk = .{ .a = a, .g = g, .source = source };
    walk.visit(source);

    var env_decls_of: std.AutoHashMapUnmanaged(*Node, []const ?*Node) = .empty;
    var env_vars_of: std.AutoHashMapUnmanaged(*Node, []const []const u8) = .empty;
    var it = walk.captured.iterator();
    while (it.next()) |e| {
        const entries = a.alloc(Entry, e.value_ptr.count()) catch oom();
        for (entries, e.value_ptr.keys(), e.value_ptr.values()) |*out, decl, name| out.* = .{ .decl = decl, .name = name };
        std.sort.block(Entry, entries, {}, entryLess);
        const decls = a.alloc(?*Node, entries.len) catch oom();
        const names = a.alloc([]const u8, entries.len) catch oom();
        for (entries, decls, names) |entry, *d, *n| {
            d.* = entry.decl;
            n.* = entry.name;
        }
        env_decls_of.put(a, e.key_ptr.*, decls) catch oom();
        env_vars_of.put(a, e.key_ptr.*, names) catch oom();
    }

    const hasEnv = struct {
        fn call(vars: *const std.AutoHashMapUnmanaged(*Node, []const []const u8), f: *Node) bool {
            return (vars.get(f) orelse return false).len > 0;
        }
    }.call;

    var captures_of: std.AutoHashMapUnmanaged(*Node, std.StringArrayHashMapUnmanaged(EnvCapture)) = .empty;
    for (walk.references.items) |r| {
        const ref_fn = enclosingFunction(r.ref) orelse continue;
        const env = env_decls_of.get(r.decl_fn) orelse continue;
        const index = std.mem.indexOfScalar(?*Node, env, r.decl) orelse continue;
        var levels: u32 = 0;
        if (r.decl_fn.data == .class) {
            var at = enclosingScope(ref_fn);
            while (at) |s| : (at = enclosingScope(s)) {
                if (s == r.decl_fn) break;
                if (isFunctionLike(s) and hasEnv(&env_vars_of, s)) levels += 1;
            }
        } else {
            var at = enclosingFunction(ref_fn);
            while (at) |s| : (at = enclosingFunction(s)) {
                if (s == r.decl_fn) break;
                if (hasEnv(&env_vars_of, s)) levels += 1;
            }
        }
        const own = captures_of.getOrPut(a, ref_fn) catch oom();
        if (!own.found_existing) own.value_ptr.* = .empty;
        own.value_ptr.put(a, r.name, .{ .name = r.name, .decl = r.decl, .levels = levels, .index = @intCast(index) }) catch oom();
    }

    var needs_env: std.AutoHashMapUnmanaged(*Node, void) = .empty;
    for (walk.references.items) |r| {
        const ref_fn = enclosingFunction(r.ref) orelse continue;
        var f: ?*Node = ref_fn;
        if (r.decl_fn.data == .class) {
            while (f) |x| : (f = enclosingScope(x)) {
                if (x == r.decl_fn) break;
                needs_env.put(a, x, {}) catch oom();
            }
            continue;
        }
        while (f) |x| : (f = enclosingFunction(x)) {
            if (x == r.decl_fn) break;
            needs_env.put(a, x, {}) catch oom();
        }
    }

    const result = a.create(CaptureMap) catch oom();
    result.* = .empty;
    var collect: Collect = .{ .a = a, .result = result, .env_vars = &env_vars_of, .env_decls = &env_decls_of, .captures_of = &captures_of, .needs_env = &needs_env };
    collect.record(source);
    collect.visit(source);
    return result;
}
