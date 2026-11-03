//! Oracle diff (`ffi-gen/diff.ts`): a generated binding against the hand-written one, matched by C
//! symbol. Pure over what `hand.zig` read.
const std = @import("std");
const Allocator = std.mem.Allocator;
const abi = @import("abi.zig");
const emit = @import("emit.zig");
const text = @import("text.zig");
const GenResult = emit.GenResult;
const eql = std.mem.eql;
const oom = text.oom;
const fmt = text.fmt;

pub const HandFunction = struct {
    ts_name: []const u8,
    c_name: []const u8,
    param_types: []const []const u8,
    ret_type: []const u8,
};

pub const DiffStatus = enum {
    match,
    mismatch,
    @"gen-only",
    @"hand-only-emittable",
    @"hand-only-refused",
};

pub const DiffEntry = struct {
    status: DiffStatus,
    c_name: []const u8,
    detail: []const u8,
};

fn generatedParams(a: Allocator, fn_: *const abi.MappedFunction) []const u8 {
    const types = a.alloc([]const u8, fn_.params.len) catch oom();
    for (fn_.params, types) |p, *t| t.* = p.ts_type;
    return std.mem.join(a, ", ", types) catch oom();
}

/// `hand-only-refused` is the row oracle work reads: a generator bug, a manual-binding bug, or a
/// documented rule divergence.
pub fn diffBindings(a: Allocator, result: *const GenResult, hand: []const HandFunction) []const DiffEntry {
    var gen_by_c: std.StringHashMapUnmanaged(*const abi.MappedFunction) = .empty;
    for (result.functions) |*fn_| gen_by_c.put(a, fn_.c_name, fn_) catch oom();
    var refused_by_c: std.StringHashMapUnmanaged(emit.Refusal) = .empty;
    for (result.refusals) |refusal| refused_by_c.put(a, refusal.construct, refusal) catch oom();
    var hand_by_c: std.StringHashMapUnmanaged(*const HandFunction) = .empty;
    for (hand) |*fn_| hand_by_c.put(a, fn_.c_name, fn_) catch oom();

    var seen: std.StringArrayHashMapUnmanaged(void) = .empty;
    var gen_names = gen_by_c.keyIterator();
    while (gen_names.next()) |name| seen.put(a, name.*, {}) catch oom();
    var hand_names = hand_by_c.keyIterator();
    while (hand_names.next()) |name| seen.put(a, name.*, {}) catch oom();
    const names = a.dupe([]const u8, seen.keys()) catch oom();
    std.mem.sort([]const u8, names, {}, text.lessString);

    var entries: std.ArrayList(DiffEntry) = .empty;
    for (names) |name| {
        const gen = gen_by_c.get(name);
        const handwritten = hand_by_c.get(name);
        if (gen != null and handwritten == null) {
            entries.append(a, .{ .status = .@"gen-only", .c_name = name, .detail = fmt(a, "generated as {s}({s}): {s}", .{ gen.?.ts_name, generatedParams(a, gen.?), gen.?.ret }) }) catch oom();
        } else if (gen == null and handwritten != null) {
            if (refused_by_c.get(name)) |refused| {
                entries.append(a, .{ .status = .@"hand-only-refused", .c_name = name, .detail = fmt(a, "generator refuses: {s}", .{refused.reason}) }) catch oom();
            } else {
                entries.append(a, .{ .status = .@"hand-only-emittable", .c_name = name, .detail = fmt(a, "hand-written as {s} but no header declaration found (renamed? from another header?)", .{handwritten.?.ts_name}) }) catch oom();
            }
        } else if (gen != null and handwritten != null) {
            entries.append(a, compared(a, name, gen.?, handwritten.?)) catch oom();
        }
    }
    return entries.items;
}

fn compared(a: Allocator, name: []const u8, gen: *const abi.MappedFunction, handwritten: *const HandFunction) DiffEntry {
    var differences: std.ArrayList([]const u8) = .empty;
    if (!eql(u8, gen.ts_name, handwritten.ts_name))
        differences.append(a, fmt(a, "ts-name gen=`{s}` hand=`{s}`", .{ gen.ts_name, handwritten.ts_name })) catch oom();
    const gen_params = generatedParams(a, gen);
    const hand_params = std.mem.join(a, ", ", handwritten.param_types) catch oom();
    if (!eql(u8, gen_params, hand_params))
        differences.append(a, fmt(a, "params gen=`({s})` hand=`({s})`", .{ gen_params, hand_params })) catch oom();
    if (!eql(u8, gen.ret, handwritten.ret_type))
        differences.append(a, fmt(a, "return gen=`{s}` hand=`{s}`", .{ gen.ret, handwritten.ret_type })) catch oom();
    if (differences.items.len == 0) return .{ .status = .match, .c_name = name, .detail = fmt(a, "identical as {s}", .{gen.ts_name}) };
    return .{ .status = .mismatch, .c_name = name, .detail = std.mem.join(a, "; ", differences.items) catch oom() };
}

pub fn renderDiffReport(a: Allocator, entries: []const DiffEntry, generated_name: []const u8, hand_name: []const u8) []const u8 {
    var counts: std.EnumArray(DiffStatus, usize) = .initFill(0);
    for (entries) |entry| counts.getPtr(entry.status).* += 1;
    var out: std.ArrayList(u8) = .empty;
    out.appendSlice(a, fmt(a, "oracle diff: generated {s} vs hand-written {s}\n", .{ generated_name, hand_name })) catch oom();
    out.appendSlice(a, fmt(a, "{d} C symbols compared: {d} match, {d} mismatch, {d} gen-only, {d} hand-only-emittable, {d} hand-only-refused\n", .{
        entries.len,
        counts.get(.match),
        counts.get(.mismatch),
        counts.get(.@"gen-only"),
        counts.get(.@"hand-only-emittable"),
        counts.get(.@"hand-only-refused"),
    })) catch oom();
    for (entries) |entry| {
        if (entry.status != .match) out.appendSlice(a, fmt(a, "  [{t}] {s}: {s}\n", .{ entry.status, entry.c_name, entry.detail })) catch oom();
    }
    return out.items;
}
