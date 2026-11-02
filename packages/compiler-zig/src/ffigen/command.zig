//! `statorc-zig ffi-gen` (`packages/compiler/src/ffi-gen/main.ts`): C header to Stator `.d.ts`.
//! Exit codes are the tool's: 0 success and `--help`, 2 bad arguments, 1 clang, 4 I/O. Its 3 is a
//! stack overflow on a deep dump, which the iterative walk here cannot have.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const ast = @import("ast.zig");
const diff = @import("diff.zig");
const emit = @import("emit.zig");
const hand = @import("hand.zig");
const model = @import("model.zig");
const text = @import("text.zig");
const outputs = @import("../cli/outputs.zig");
const diagnostics = @import("../support/root.zig").diagnostics;
const eql = std.mem.eql;
const oom = text.oom;

const usage =
    "usage: ffi-gen/main.ts <header.h> [--out=<file.d.ts>] [--diff=<handwritten.d.ts>] " ++
    "[--clang=<cc>] [--lib=<name>]... [-I<dir>]... [-D<def>]...";

const Options = struct {
    header: []const u8,
    out: ?[]const u8,
    diff: ?[]const u8,
    clang: []const u8,
    libs: []const []const u8,
    extra: []const []const u8,
};

const Parsed = union(enum) {
    help,
    /// The message `main.ts` prints before it exits 2.
    refused: []const u8,
    options: Options,
};

fn isLibName(lib: []const u8) bool {
    if (lib.len == 0) return false;
    for (lib) |b| {
        if (!text.isWordByte(b) and b != '.' and b != '+' and b != '-') return false;
    }
    return true;
}

/// One resolved spelling, or one inode reached through a link: `--out` overwrites either in place.
fn sameFile(a: Allocator, io: Io, x: []const u8, y: []const u8) bool {
    const left = outputs.absolutePath(a, io, x);
    const right = outputs.absolutePath(a, io, y);
    if (eql(u8, left, right)) return true;
    const key = outputs.statKey(a, io, left) orelse return false;
    return eql(u8, key, outputs.statKey(a, io, right) orelse return false);
}

fn refused(a: Allocator, comptime format: []const u8, args: anytype) Parsed {
    return .{ .refused = std.fmt.allocPrint(a, "ffi-gen: " ++ format ++ "\n" ++ usage, args) catch oom() };
}

fn parseArgs(a: Allocator, io: Io, argv: []const [:0]const u8, cc: ?[]const u8) Parsed {
    var header: ?[]const u8 = null;
    var out: ?[]const u8 = null;
    var diff_file: ?[]const u8 = null;
    var clang = cc orelse "clang";
    var libs: std.ArrayList([]const u8) = .empty;
    var extra: std.ArrayList([]const u8) = .empty;
    for (argv) |arg| {
        if (eql(u8, arg, "--help") or eql(u8, arg, "-h")) return .help;
        if (std.mem.startsWith(u8, arg, "--out=")) {
            out = arg["--out=".len..];
        } else if (std.mem.startsWith(u8, arg, "--diff=")) {
            diff_file = arg["--diff=".len..];
        } else if (std.mem.startsWith(u8, arg, "--clang=")) {
            clang = arg["--clang=".len..];
        } else if (std.mem.startsWith(u8, arg, "--lib=")) {
            libs.append(a, arg["--lib=".len..]) catch oom();
        } else if (std.mem.startsWith(u8, arg, "-I") or std.mem.startsWith(u8, arg, "-D")) {
            extra.append(a, arg) catch oom();
        } else if (std.mem.startsWith(u8, arg, "-")) {
            return refused(a, "unknown flag '{s}'", .{arg});
        } else if (header == null) {
            header = arg;
        } else {
            return refused(a, "unexpected positional argument '{s}'", .{arg});
        }
    }
    const input = header orelse return refused(a, "no header given", .{});
    const empty = clang.len == 0 or (out != null and out.?.len == 0) or (diff_file != null and diff_file.?.len == 0);
    var empty_lib = false;
    for (libs.items) |lib| empty_lib = empty_lib or lib.len == 0;
    if (empty or empty_lib) return refused(a, "empty flag value", .{});
    for (libs.items) |lib| {
        if (isLibName(lib)) continue;
        var shown: Io.Writer.Allocating = .init(a);
        diagnostics.writeJsonString(&shown.writer, lib) catch oom();
        return refused(a, "--lib expects a library name (letters, digits, _ . + -), got {s}", .{shown.written()});
    }
    if (out) |target| {
        const clash = sameFile(a, io, input, target) or (diff_file != null and sameFile(a, io, diff_file.?, target));
        if (clash) return refused(a, "--out must differ from the input header and --diff file", .{});
    }
    return .{ .options = .{ .header = input, .out = out, .diff = diff_file, .clang = clang, .libs = libs.items, .extra = extra.items } };
}

fn print(io: Io, file: Io.File, bytes: []const u8) void {
    file.writeStreamingAll(io, bytes) catch {};
}

fn fail(a: Allocator, io: Io, code: u8, comptime format: []const u8, args: anytype) u8 {
    print(io, Io.File.stderr(), std.fmt.allocPrint(a, format, args) catch oom());
    return code;
}

fn readAll(a: Allocator, io: Io, path: []const u8) ?[]const u8 {
    const bytes = Io.Dir.cwd().readFileAlloc(io, path, a, .unlimited) catch return null;
    return text.lossyUtf8(a, bytes);
}

pub fn run(a: Allocator, io: Io, argv: []const [:0]const u8, cc: ?[]const u8, cwd: []const u8) u8 {
    const options = switch (parseArgs(a, io, argv, cc)) {
        .help => {
            print(io, Io.File.stdout(), usage ++ "\n");
            return 0;
        },
        .refused => |message| return fail(a, io, 2, "{s}\n", .{message}),
        .options => |options| options,
    };
    const header_text = readAll(a, io, options.header) orelse return fail(a, io, 4, "ffi-gen: cannot read header '{s}'\n", .{options.header});
    const root = switch (ast.runClangAstDump(a, io, options.clang, options.header, options.extra)) {
        .root => |root| root,
        .failed => |message| return fail(a, io, 1, "{s}\n", .{message}),
    };
    const header_model = model.buildModel(a, root, options.header, header_text, cwd);
    const result = emit.generate(a, &header_model);
    const dts = emit.renderDts(a, &result, options.libs);
    if (options.diff) |file| {
        const source = readAll(a, io, file) orelse return fail(a, io, 4, "ffi-gen: cannot read handwritten file '{s}'\n", .{file});
        const written = hand.readHandwritten(a, io, source, file);
        print(io, Io.File.stdout(), diff.renderDiffReport(a, diff.diffBindings(a, &result, written), options.header, file));
    }
    if (options.out) |target| {
        Io.Dir.cwd().writeFile(io, .{ .sub_path = target, .data = dts }) catch return fail(a, io, 4, "ffi-gen: cannot write '{s}'\n", .{target});
    } else if (options.diff == null) {
        print(io, Io.File.stdout(), dts);
    }
    var messages: std.ArrayList(u8) = .empty;
    for (result.refusals) |refusal| {
        messages.appendSlice(a, emit.diagnosticLine(a, result.basename, refusal)) catch oom();
        messages.append(a, '\n') catch oom();
    }
    messages.appendSlice(a, emit.summaryLine(a, &result)) catch oom();
    messages.append(a, '\n') catch oom();
    print(io, Io.File.stderr(), messages.items);
    return 0;
}
