//! Module locations and the Node globals (`process`, `performance`, the timer functions) under
//! `--node`. A native binary has no source files,
//! so a read of where a module is becomes a call answered at run time, relative to the executable.
//! The rewrite is text: the imports join the file's first line and each read is replaced in place,
//! so no line moves. Nothing below the frontend sees the reads or the rewrite.
const std = @import("std");
const Allocator = std.mem.Allocator;
const fspath = std.fs.path;
const stator_ts = @import("stator_ts");
const ast = stator_ts.ast;
const project = stator_ts.project;
const support = @import("../support/root.zig");
const api = @import("gate_api.zig");
const gate_modules = @import("gate_modules.zig");
const node_edge = @import("node.zig");
const std_edge = @import("std.zig");
const Node = ast.Node;
const SourceFile = project.SourceFile;

fn oom() noreturn {
    @panic("out of memory");
}

const Read = enum { url, filename, dirname };

fn helper(read: Read) []const u8 {
    return switch (read) {
        .url => "__statorModuleUrl",
        .filename => "__statorFilename",
        .dirname => "__statorDirname",
    };
}

const Site = struct { start: u32, end: u32, read: Read };

fn importMetaRead(n: *const Node) ?Read {
    if (n.data != .prop_access) return null;
    const access = n.data.prop_access;
    if (access.expr.data != .meta_property or access.expr.data.meta_property.keyword != .kw_import) return null;
    const name = access.name.data.identifier;
    return std.meta.stringToEnum(Read, name);
}

fn siteOf(_: void, n: *Node) ?Site {
    const read = importMetaRead(n) orelse return null;
    return .{ .start = n.start, .end = n.end, .read = read };
}

/// A free read of one of these names becomes an import of the module export that implements it.
const Global = struct { name: []const u8, module: []const u8, default: bool = false };

/// Sorted by module, then by name: the order the imports are written in.
const node_globals = [_]Global{
    .{ .name = "performance", .module = "node:perf_hooks" },
    .{ .name = "process", .module = "node:process", .default = true },
    .{ .name = "clearImmediate", .module = "node:timers" },
    .{ .name = "clearInterval", .module = "node:timers" },
    .{ .name = "clearTimeout", .module = "node:timers" },
    .{ .name = "setImmediate", .module = "node:timers" },
    .{ .name = "setInterval", .module = "node:timers" },
    .{ .name = "setTimeout", .module = "node:timers" },
};

const GlobalRead = struct { gate: *const api.Gate, name: []const u8 };

fn globalStep(read: GlobalRead, n: *Node) support.ast_walk.Step {
    return if (n.data == .identifier and gate_modules.isFreeCommonJsName(read.gate, n, read.name)) .match else .descend;
}

/// One import per module for the globals read: `import process from "node:process"; import {
/// clearTimeout, setTimeout } from "node:timers"; `. Empty when the file reads none.
fn globalsHeader(a: Allocator, root: *Node, gate: *const api.Gate) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    var named: std.ArrayList(u8) = .empty;
    for (node_globals, 0..) |global, index| {
        if (support.ast_walk.contains(root, GlobalRead{ .gate = gate, .name = global.name }, globalStep)) {
            if (global.default) {
                out.print(a, "import {s} from \"{s}\"; ", .{ global.name, global.module }) catch oom();
            } else {
                if (named.items.len != 0) named.appendSlice(a, ", ") catch oom();
                named.appendSlice(a, global.name) catch oom();
            }
        }
        const last = index + 1 == node_globals.len or !std.mem.eql(u8, node_globals[index + 1].module, global.module);
        if (last and named.items.len != 0) {
            out.print(a, "import {{ {s} }} from \"{s}\"; ", .{ named.items, global.module }) catch oom();
            named.clearRetainingCapacity();
        }
    }
    return out.items;
}

fn importOffset(text: []const u8) usize {
    if (!std.mem.startsWith(u8, text, "#!")) return 0;
    const end = std.mem.indexOfScalar(u8, text, '\n') orelse return text.len;
    return end + 1;
}

fn relative(a: Allocator, from: []const u8, to: []const u8) []const u8 {
    return fspath.relativeAllocPosix(a, "/", from, to) catch oom();
}

fn appendJson(a: Allocator, out: *std.ArrayList(u8), text: []const u8) void {
    var writer: std.Io.Writer.Allocating = .fromArrayList(a, out);
    support.diagnostics.writeJsonString(&writer.writer, text) catch oom();
    out.* = writer.toArrayList();
}

fn lessSite(_: void, l: Site, r: Site) bool {
    return l.start < r.start;
}

fn rewrite(a: Allocator, file: *const ast.File, sites: []Site, globals: []const u8, own: []const u8, node: node_edge.Package) []const u8 {
    var used: [3]bool = @splat(false);
    for (sites) |site| used[@backingInt(site.read)] = true;
    // Sorted: `__statorDirname`, `__statorFilename`, `__statorModuleUrl`.
    const order = [_]Read{ .dirname, .filename, .url };
    var names: std.ArrayList(u8) = .empty;
    for (order) |read| {
        if (!used[@backingInt(read)]) continue;
        if (names.items.len != 0) names.appendSlice(a, ", ") catch oom();
        names.appendSlice(a, helper(read)) catch oom();
    }
    var out: std.ArrayList(u8) = .empty;
    const text = file.src;
    const at = importOffset(text);
    out.appendSlice(a, text[0..at]) catch oom();
    out.appendSlice(a, globals) catch oom();
    if (names.items.len != 0) {
        const nearby = relative(a, fspath.dirname(file.path) orelse "/", node.locationFile());
        const specifier = if (std.mem.startsWith(u8, nearby, "../")) nearby else std.fmt.allocPrint(a, "./{s}", .{nearby}) catch oom();
        out.print(a, "import {{ {s} }} from ", .{names.items}) catch oom();
        appendJson(a, &out, specifier);
        out.appendSlice(a, "; ") catch oom();
    }
    std.mem.sort(Site, sites, {}, lessSite);
    var from = at;
    for (sites) |site| {
        out.appendSlice(a, text[from..site.start]) catch oom();
        out.print(a, "{s}(", .{helper(site.read)}) catch oom();
        appendJson(a, &out, own);
        out.append(a, ')') catch oom();
        from = site.end;
    }
    out.appendSlice(a, text[from..]) catch oom();
    return out.items;
}

pub fn isProjectFile(sf: *const SourceFile, std_package: std_edge.Package) bool {
    const name = sf.file.path;
    return !sf.file.is_dts and !sf.is_lib and !std_package.isSourceFile(name) and std.mem.indexOf(u8, name, "/node_modules/") == null;
}

/// Every file that reads its location or a Node global, by name; empty when none does.
pub fn locationRewrites(a: Allocator, prog: *project.Program, gate: *const api.Gate, entry: *const SourceFile, std_package: std_edge.Package, node: node_edge.Package) project.Overlay {
    var rewrites: project.Overlay = .empty;
    const entry_dir = fspath.dirname(entry.file.path) orelse "/";
    for (prog.files.items) |sf| {
        if (!isProjectFile(sf, std_package) or node.isSourceFile(sf.file.path)) continue;
        const sites = support.ast_walk.collect(Site, a, sf.file.root, {}, siteOf) catch oom();
        const globals = globalsHeader(a, sf.file.root, gate);
        if (sites.len == 0 and globals.len == 0) continue;
        const own = relative(a, entry_dir, sf.file.path);
        rewrites.put(a, sf.file.path, rewrite(a, sf.file, sites, globals, own, node)) catch oom();
    }
    return rewrites;
}

test "the imports join the line after a shebang" {
    try std.testing.expectEqual(@as(usize, 0), importOffset("x"));
    try std.testing.expectEqual(@as(usize, 6), importOffset("#!/x\r\ny"));
    try std.testing.expectEqual(@as(usize, 4), importOffset("#!/x"));
}
