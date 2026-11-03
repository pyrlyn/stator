//! The subcommands `packages/tests/zigdiff` reaches the verifier and the passes through. Each reads
//! one HIR-JSON dump, so these two stages can be held to the TypeScript compiler before anything
//! in front of them is ported.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const json = @import("../hir/json.zig");
const nodes = @import("../hir/nodes.zig");
const verify = @import("../hir/verify.zig");
const optimize = @import("root.zig").optimize;

pub const USAGE =
    \\  verify <hir.json>                  print what the HIR verifier finds; exit 1 when it finds any
    \\  passes [--root=<name>]... <hir.json>   print the HIR after every pass
    \\
;

/// Exit status of a run that could not answer, as opposed to one that found problems.
pub const FAILED: u8 = 2;

pub fn fail(io: Io, arena: Allocator, comptime format: []const u8, args: anytype) u8 {
    const text = std.fmt.allocPrint(arena, "STA4072: internal error: " ++ format ++ " — this is a compiler bug; report it with the input that triggered it\n", args) catch return FAILED;
    Io.File.stderr().writeStreamingAll(io, text) catch {};
    return FAILED;
}

/// Failing to write is not an answer either, and a harness reading a truncated dump must not take
/// it for one.
fn emit(io: Io, arena: Allocator, text: []const u8) u8 {
    Io.File.stdout().writeStreamingAll(io, text) catch |err| return fail(io, arena, "{t} writing the result", .{err});
    return 0;
}

/// The whole file, or null once the failure is reported.
pub fn readInput(io: Io, arena: Allocator, path: []const u8) ?[]const u8 {
    return Io.Dir.cwd().readFileAlloc(io, path, arena, .unlimited) catch |err| {
        _ = fail(io, arena, "{t} reading {s}", .{ err, path });
        return null;
    };
}

pub fn load(io: Io, arena: Allocator, path: []const u8) ?*const nodes.Module {
    const text = readInput(io, arena, path) orelse return null;
    var failure: json.Failure = .{};
    return json.read(arena, text, &failure) catch |err| {
        _ = fail(io, arena, "{s}: {t} at byte {d}: {s}", .{ path, err, failure.offset, failure.reason });
        return null;
    };
}

/// One line per problem, in the verifier's order. The span is part of the answer: the right problem
/// at the wrong node is not agreement.
pub fn runVerify(io: Io, arena: Allocator, args: []const [:0]const u8) u8 {
    if (args.len != 1) return fail(io, arena, "verify takes one dump, not {d} arguments", .{args.len});
    const module = load(io, arena, args[0]) orelse return FAILED;
    const problems = verify.verifyHir(arena, module) catch return fail(io, arena, "out of memory verifying {s}", .{args[0]});
    var out: std.ArrayList(u8) = .empty;
    for (problems) |problem| {
        const span = problem.span;
        out.print(arena, "{s}\t{s}\t{d}:{d}:{d}\t{s}\n", .{ problem.code, problem.kind, span.start, span.length, span.line, problem.message }) catch {
            return fail(io, arena, "out of memory printing {s}", .{args[0]});
        };
    }
    const status = emit(io, arena, out.items);
    return if (status != 0 or problems.len == 0) status else 1;
}

pub fn runPasses(io: Io, arena: Allocator, args: []const [:0]const u8) u8 {
    var roots: std.ArrayList([]const u8) = .empty;
    var path: ?[]const u8 = null;
    for (args) |arg| {
        if (std.mem.startsWith(u8, arg, "--root=")) {
            roots.append(arena, arg["--root=".len..]) catch return fail(io, arena, "out of memory", .{});
        } else if (path == null) {
            path = arg;
        } else {
            return fail(io, arena, "passes takes one dump, and {s} is a second", .{arg});
        }
    }
    const dump = path orelse return fail(io, arena, "passes takes one dump, and got none", .{});
    const module = load(io, arena, dump) orelse return FAILED;
    const optimized = optimize(arena, module, roots.items) catch |err| return fail(io, arena, "{t} in the passes over {s}", .{ err, dump });
    const text = json.write(arena, optimized) catch |err| return fail(io, arena, "{t} writing {s}", .{ err, dump });
    return emit(io, arena, text);
}

test {
    _ = verify;
}
