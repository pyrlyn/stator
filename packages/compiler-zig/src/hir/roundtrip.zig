//! Throwaway proof driver: reads every path listed in argv[1], writes it back and compares bytes.
//! Argv[2], when given, is how many random one-byte mutations of each file must not crash.

const std = @import("std");
const json = @import("json.zig");

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    const cwd = std.Io.Dir.cwd();
    const list = try cwd.readFileAlloc(io, args[1], gpa, .unlimited);
    defer gpa.free(list);
    const mutations = if (args.len > 2) try std.fmt.parseInt(usize, args[2], 10) else 0;

    var count: struct { equal: usize = 0, differ: usize = 0, rejected: usize = 0, mutated_ok: usize = 0, mutated_bad: usize = 0, bytes: usize = 0 } = .{};
    var random: std.Random.DefaultPrng = .init(0x57a70);
    var lines = std.mem.tokenizeScalar(u8, list, '\n');
    while (lines.next()) |path| {
        const text = try cwd.readFileAlloc(io, path, gpa, .unlimited);
        defer gpa.free(text);
        count.bytes += text.len;
        var state: std.heap.ArenaAllocator = .init(gpa);
        defer state.deinit();
        var failure: json.Failure = .{};
        const module = json.read(state.allocator(), text, &failure) catch |err| {
            count.rejected += 1;
            const from = failure.offset -| 60;
            std.debug.print("REJECT {s}: {t}: {s} at {d}: {s}\n", .{
                path,                                            err, failure.reason, failure.offset,
                text[from..@min(failure.offset + 60, text.len)],
            });
            continue;
        };
        const back = try json.write(gpa, module);
        defer gpa.free(back);
        if (std.mem.eql(u8, back, text)) {
            count.equal += 1;
        } else {
            count.differ += 1;
            const at = std.mem.indexOfDiff(u8, back, text) orelse 0;
            std.debug.print("DIFFER {s} at {d}\n  in : {s}\n  out: {s}\n", .{
                path,                                    at,
                text[at -| 60..@min(at + 60, text.len)], back[at -| 60..@min(at + 60, back.len)],
            });
        }
        const copy = try gpa.dupe(u8, text);
        defer gpa.free(copy);
        for (0..mutations) |_| {
            const i = random.random().uintLessThan(usize, copy.len);
            const original = copy[i];
            copy[i] = random.random().int(u8);
            defer copy[i] = original;
            var mutant: std.heap.ArenaAllocator = .init(gpa);
            defer mutant.deinit();
            if (json.read(mutant.allocator(), copy, &failure)) |tree| {
                gpa.free(try json.write(gpa, tree));
                count.mutated_ok += 1;
            } else |_| {
                count.mutated_bad += 1;
            }
        }
    }
    std.debug.print(
        "files {d} byte-equal {d} differ {d} rejected {d} bytes {d} mutants rejected {d} accepted {d}\n",
        .{ count.equal + count.differ + count.rejected, count.equal, count.differ, count.rejected, count.bytes, count.mutated_bad, count.mutated_ok },
    );
}
