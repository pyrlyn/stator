//! Golden tests: the Zig lexer's token stream must equal the TypeScript scanner's, byte for
//! byte, on every sample. Regenerate with `node packages/compiler-zig/tools/gen-golden.ts`.

const std = @import("std");
const lexer = @import("lexer.zig");

const samples = [_][]const u8{ "basics", "keywords", "literals", "operators", "program", "unicode" };

test "token streams match the TypeScript scanner" {
    inline for (samples) |name| {
        const source = @embedFile("testdata/samples/" ++ name ++ ".ts");
        const golden = @embedFile("testdata/golden/" ++ name ++ ".tokens");
        var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer out.deinit();
        try lexer.dump(source, &out.writer);
        std.testing.expectEqualStrings(golden, out.written()) catch |err| {
            std.debug.print("golden mismatch in sample `{s}`\n", .{name});
            return err;
        };
    }
}
