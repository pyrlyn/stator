//! The deterministic `.d.ts` printer (`ffi-gen/emit.ts`): functions by C name, brands by alias,
//! refusals by line, no timestamps, no absolute paths.
const std = @import("std");
const Allocator = std.mem.Allocator;
const abi = @import("abi.zig");
const model_ = @import("model.zig");
const text = @import("text.zig");
const CFunction = model_.CFunction;
const CGlobal = model_.CGlobal;
const HeaderModel = model_.HeaderModel;
const MappedFunction = abi.MappedFunction;
const oom = text.oom;
const fmt = text.fmt;

pub const Brand = abi.BrandRef;

pub const Refusal = abi.Refusal;

pub const GenResult = struct {
    basename: []const u8,
    functions: []const MappedFunction,
    brands: []const Brand,
    uses_cstring: bool,
    uses_out_alias: bool,
    int_widened: bool,
    size_widened: bool,
    refusals: []const Refusal,
};

fn refusalSuffix(a: Allocator, refusal: Refusal) []const u8 {
    const code = refusal.code orelse return " [no STA code allocated yet]";
    return fmt(a, " [would-be {s}]", .{code});
}

fn refusalWhere(a: Allocator, basename: []const u8, refusal: Refusal) []const u8 {
    return if (refusal.line > 0) fmt(a, "{s}:{d}", .{ basename, refusal.line }) else basename;
}

fn refusalComment(a: Allocator, basename: []const u8, refusal: Refusal) []const u8 {
    return fmt(a, "// {s}: {s} — {s}{s}", .{ refusalWhere(a, basename, refusal), refusal.construct, refusal.reason, refusalSuffix(a, refusal) });
}

pub fn diagnosticLine(a: Allocator, basename: []const u8, refusal: Refusal) []const u8 {
    return fmt(a, "ffi-gen: {s}: {s}: refused — {s}{s}", .{ refusalWhere(a, basename, refusal), refusal.construct, refusal.reason, refusalSuffix(a, refusal) });
}

fn ownershipComment(a: Allocator, fn_: *const MappedFunction) []const u8 {
    var parts: std.ArrayList([]const u8) = .empty;
    var borrows: std.ArrayList(u8) = .empty;
    var outs: std.ArrayList(u8) = .empty;
    for (fn_.params) |p| {
        switch (p.ownership) {
            .borrow, .pointer => {
                if (borrows.items.len != 0) borrows.appendSlice(a, ", ") catch oom();
                borrows.appendSlice(a, fmt(a, "`{s}` {s}", .{ p.ts_name, if (p.ownership == .borrow) "borrowed" else "borrowed opaque" })) catch oom();
            },
            .out => {
                if (outs.items.len != 0) outs.appendSlice(a, ", ") catch oom();
                outs.appendSlice(a, fmt(a, "`{s}` out-param written on success", .{p.ts_name})) catch oom();
            },
            .value => {},
        }
    }
    if (borrows.items.len != 0) parts.append(a, fmt(a, "{s} for the call", .{borrows.items})) catch oom();
    if (outs.items.len != 0) parts.append(a, outs.items) catch oom();
    switch (fn_.ret_ownership) {
        .copy_out => parts.append(a, "return copied to a fresh string at the boundary") catch oom(),
        .handle => parts.append(a, "return is a library-owned opaque handle") catch oom(),
        else => {},
    }
    if (parts.items.len == 0) parts.append(a, "none — value copies in, plain value out") catch oom();
    return fmt(a, "// Ownership (generated): {s}. No error convention inferred.", .{std.mem.join(a, "; ", parts.items) catch oom()});
}

fn byCName(_: void, x: CFunction, y: CFunction) bool {
    return text.lessUtf16(x.c_name, y.c_name);
}

fn byLine(_: void, x: CGlobal, y: CGlobal) bool {
    return x.line < y.line;
}

/// The oracle's comparator answers 1 for equal keys, and V8's sort still keeps them in order.
fn refusalLess(_: void, x: Refusal, y: Refusal) bool {
    return if (x.line != y.line) x.line < y.line else text.lessUtf16(x.construct, y.construct);
}

/// A map's entries as `Row`s (key field first, value second), in the oracle's UTF-16 key order.
fn sortedByKey(comptime Row: type, a: Allocator, map: anytype) []Row {
    const names = comptime std.meta.fieldNames(Row);
    const rows = a.alloc(Row, map.count()) catch oom();
    for (map.keys(), map.values(), rows) |key, value, *row| {
        @field(row.*, names[0]) = key;
        @field(row.*, names[1]) = value;
    }
    std.mem.sort(Row, rows, {}, struct {
        fn less(_: void, x: Row, y: Row) bool {
            return text.lessUtf16(@field(x, names[0]), @field(y, names[0]));
        }
    }.less);
    return rows;
}

fn collectBrands(a: Allocator, functions: []const MappedFunction) []const Brand {
    var tags: std.StringArrayHashMapUnmanaged([]const u8) = .empty;
    const add = struct {
        fn run(x: Allocator, map: *std.StringArrayHashMapUnmanaged([]const u8), brand: ?Brand) void {
            const b = brand orelse return;
            const slot = map.getOrPut(x, b.alias) catch oom();
            if (!slot.found_existing) slot.value_ptr.* = b.tag;
        }
    }.run;
    for (functions) |fn_| {
        for (fn_.params) |param| add(a, &tags, param.brand);
        add(a, &tags, fn_.ret_brand);
    }
    return sortedByKey(Brand, a, tags);
}

/// Everything the header yields. Pure over the model: clang never runs here.
pub fn generate(a: Allocator, model: *const HeaderModel) GenResult {
    var taken: abi.Names = .empty;
    for ([_][]const u8{ "CString", "CStringOwned", "Out" }) |name| taken.put(a, name, {}) catch oom();
    var functions: std.ArrayList(MappedFunction) = .empty;
    var refusals: std.ArrayList(Refusal) = .empty;

    const sorted = a.dupe(CFunction, model.functions) catch oom();
    std.mem.sort(CFunction, sorted, {}, byCName);
    for (sorted) |*fn_| {
        switch (abi.classifyFunction(a, fn_, model, &taken)) {
            .ok => |mapped| functions.append(a, mapped) catch oom(),
            .refused => |r| refusals.append(a, r) catch oom(),
        }
    }

    const globals = a.dupe(CGlobal, model.globals) catch oom();
    std.mem.sort(CGlobal, globals, {}, byLine);
    for (globals) |global| refusals.append(a, .{
        .line = global.line,
        .construct = global.name,
        .kind = "global variable",
        .reason = fmt(a, "global variable ('{s}') has no extern spelling — functions only in v0", .{global.c_type}),
        .code = "STA1130",
    }) catch oom();

    for (model.macros) |macro| refusals.append(a, .{
        .line = macro.line,
        .construct = macro.name,
        .kind = if (macro.function_like) "function-like macro" else "macro constant",
        .reason = if (macro.function_like) "function-like macro has no declaration spelling in v0" else "macro constant has no declaration spelling in v0",
        .code = "STA1130",
    }) catch oom();

    for (model.enums) |e| for (e.constants) |constant| refusals.append(a, .{
        .line = constant.line,
        .construct = constant.name,
        .kind = "enum constant",
        .reason = "enum constant has no declaration spelling in v0 (same gap as macro constants)",
        .code = "STA1130",
    }) catch oom();

    std.mem.sort(Refusal, refusals.items, {}, refusalLess);

    var int_widened = false;
    var size_widened = false;
    var uses_cstring = false;
    var uses_out_alias = false;
    for (functions.items) |fn_| {
        uses_cstring = uses_cstring or fn_.needs_cstring;
        if (fn_.ret_note) |note| switch (note) {
            .int => int_widened = true,
            .size => size_widened = true,
        };
        for (fn_.params) |param| {
            uses_out_alias = uses_out_alias or param.ownership == .out;
            if (param.c_note) |note| switch (note) {
                .int => int_widened = true,
                .size => size_widened = true,
            };
        }
    }

    return .{
        .basename = model.basename,
        .functions = functions.items,
        .brands = collectBrands(a, functions.items),
        .uses_cstring = uses_cstring,
        .uses_out_alias = uses_out_alias,
        .int_widened = int_widened,
        .size_widened = size_widened,
        .refusals = refusals.items,
    };
}

const Count = struct { kind: []const u8, count: usize };

/// `N emitted, M refused (kind: n, …)`, with kinds in sorted order.
pub fn summaryLine(a: Allocator, result: *const GenResult) []const u8 {
    var counts: std.StringArrayHashMapUnmanaged(usize) = .empty;
    for (result.refusals) |refusal| {
        const slot = counts.getOrPut(a, refusal.kind) catch oom();
        slot.value_ptr.* = if (slot.found_existing) slot.value_ptr.* + 1 else 1;
    }
    const rows = sortedByKey(Count, a, counts);
    var per_reason: std.ArrayList(u8) = .empty;
    for (rows, 0..) |row, i| {
        if (i != 0) per_reason.appendSlice(a, ", ") catch oom();
        per_reason.appendSlice(a, fmt(a, "{s}: {d}", .{ row.kind, row.count })) catch oom();
    }
    const refused = if (result.refusals.len == 0) "0 refused" else fmt(a, "{d} refused ({s})", .{ result.refusals.len, per_reason.items });
    return fmt(a, "ffi-gen: {d} emitted, {s} from {s}", .{ result.functions.len, refused, result.basename });
}

const Lines = struct {
    a: Allocator,
    out: std.ArrayList(u8) = .empty,

    fn push(l: *Lines, line: []const u8) void {
        l.out.appendSlice(l.a, line) catch oom();
        l.out.append(l.a, '\n') catch oom();
    }

    fn print(l: *Lines, comptime format: []const u8, args: anytype) void {
        l.push(fmt(l.a, format, args));
    }
};

fn paramList(a: Allocator, params: []const abi.MappedParam) []const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (params, 0..) |p, i| {
        if (i != 0) out.appendSlice(a, ", ") catch oom();
        out.appendSlice(a, fmt(a, "{s}: {s}", .{ p.ts_name, p.ts_type })) catch oom();
    }
    return out.items;
}

/// Header legend, link pragmas, shared aliases, brands, declarations, REFUSED block. The `#include`
/// names the input's basename, resolved against the `.d.ts` directory at use (docs/FFI.md §9).
pub fn renderDts(a: Allocator, result: *const GenResult, libs: []const []const u8) []const u8 {
    var l: Lines = .{ .a = a };
    l.print("// GENERATED by ffi-gen (plan.md §10 Task 7.3) from {s} — do not edit.", .{result.basename});
    l.push("// Regenerate: node packages/compiler/src/ffi-gen/main.ts <header.h> [--out=<file>]");
    l.print("// {s}.", .{summaryLine(a, result)["ffi-gen: ".len..]});
    l.push("// Error conventions are NEVER inferred — audit each function and add @statorError by hand");
    l.push("// (NOTES.md \"comparisons are plain values\"; the generator cannot tell 100/101 from failure).");
    if (result.int_widened) l.push("// C `int`-family widens to `number` (the i32 refinement has no declaration spelling).");
    if (result.size_widened) l.push("// C `size_t`/`ssize_t` widen to `number` (exact only to 2^53 — the documented size_t rule).");
    for (libs) |lib| l.print("// @statorLink: -l{s}", .{lib});
    l.print("// @statorLink #include \"./{s}\"", .{result.basename});
    l.push("");
    if (result.uses_cstring) {
        l.push("// Borrowed NUL-terminated UTF-8 at the FFI boundary (docs/FFI.md §3).");
        l.push("type CString = string & { readonly __statorCstr: 'CString' };");
        l.push("");
    }
    if (result.uses_out_alias) {
        l.push("// Out-param slot: the caller allocates the wrapper, the callee writes `value` on success.");
        l.push("type Out<T> = { readonly value: T };");
        l.push("");
    }
    for (result.brands) |brand| {
        l.print("/** Opaque `C {s}` handle (generated brand; lifetime belongs to the C library). */", .{brand.tag});
        l.print("type {s} = {{ readonly __brand: '{s}' }};", .{ brand.alias, brand.tag });
        l.push("");
    }
    for (result.functions) |*fn_| {
        l.print("// C: {s} — from {s}:{d}", .{ fn_.c_signature, result.basename, fn_.line });
        l.push(ownershipComment(a, fn_));
        l.print("/** @statorExtern {s} */", .{fn_.c_name});
        // Generated files pass the same `oxfmt --check` as written ones, whose print width is 100.
        const single = fmt(a, "declare function {s}({s}): {s};", .{ fn_.ts_name, paramList(a, fn_.params), fn_.ret });
        if (text.utf16Length(single) <= 100) {
            l.push(single);
        } else {
            l.print("declare function {s}(", .{fn_.ts_name});
            for (fn_.params) |p| l.print("  {s}: {s},", .{ p.ts_name, p.ts_type });
            l.print("): {s};", .{fn_.ret});
        }
        l.push("");
    }
    if (result.refusals.len > 0) {
        l.push("// ============================================================================");
        l.print("// REFUSED ({d}; v0 scope — recorded, not approximated).", .{result.refusals.len});
        for (result.refusals) |refusal| l.push(refusalComment(a, result.basename, refusal));
    } else {
        l.print("// No refusals — every declaration in {s} mapped.", .{result.basename});
    }
    return l.out.items;
}
