//! The interpreter's parser front (docs/INTERPRETER.md §1): `eval` source and the pieces of a
//! `new Function` go through stator-ts's parser into the tree the compiler reads, or stop at the
//! first early error, which the caller throws as a `SyntaxError`.

const std = @import("std");
const Allocator = std.mem.Allocator;
const parser = @import("parser");

/// stator-ts's tree, named through the parser's signature: its `ast.zig` belongs to the parser
/// module and is not exported from it.
pub const File = std.meta.Child(@typeInfo(@TypeOf(parser.parse)).@"fn".return_type.?);
pub const Node = std.meta.Child(@FieldType(File, "root"));

pub const Goal = enum { script, module };

pub const SyntaxError = struct {
    /// A byte offset into the source the parser read.
    offset: u32,
    message: []const u8,
};

pub const Result = union(enum) {
    tree: *File,
    syntax_error: SyntaxError,
};

/// The parser picks its grammar from the file name: `.js` is JavaScript without JSX, which is
/// what `eval` and `new Function` take.
const source_name = "eval.js";

/// ECMA-262 PerformEval's parse of `x` (§19.2.1.1) with the Script goal, or a module's source.
pub fn parse(a: Allocator, src: []const u8, goal: Goal) Result {
    const file = parser.parse(a, source_name, src);
    if (firstDiag(file)) |e| return .{ .syntax_error = e };
    if (goal == .script and file.is_module) return .{ .syntax_error = moduleSyntax(file) };
    return .{ .tree = file };
}

pub fn parseScript(a: Allocator, src: []const u8) Result {
    return parse(a, src, .script);
}

/// The diagnostic that starts first: the lexer reports some only after reading past them.
fn firstDiag(file: *const File) ?SyntaxError {
    if (file.diags.len == 0) return null;
    var first = file.diags[0];
    for (file.diags[1..]) |d| {
        if (d.start < first.start) first = d;
    }
    return .{ .offset = first.start, .message = first.msg };
}

/// Node's message for the declaration that made the file a module.
fn moduleSyntax(file: *const File) SyntaxError {
    for (file.root.data.source_file.stmts) |s| {
        if (s.mods.@"export") return .{ .offset = s.start, .message = "Unexpected token 'export'" };
        switch (s.data) {
            .import_decl, .import_equals => return .{ .offset = s.start, .message = "Cannot use import statement outside a module" },
            .export_decl, .export_assign => return .{ .offset = s.start, .message = "Unexpected token 'export'" },
            else => {},
        }
    }
    return .{ .offset = 0, .message = "Cannot use 'import.meta' outside a module" };
}

pub const FunctionKind = enum {
    normal,
    generator,
    async,
    async_generator,

    fn prefix(k: FunctionKind) []const u8 {
        return switch (k) {
            .normal => "function",
            .generator => "function*",
            .async => "async function",
            .async_generator => "async function*",
        };
    }
};

pub const FunctionResult = union(enum) {
    /// The `anonymous` function declaration; `file` owns the source text it spans.
    function: struct { file: *File, node: *Node },
    syntax_error: SyntaxError,
};

/// ECMA-262 CreateDynamicFunction (§20.2.1.1.1): the source text is
/// `<prefix> anonymous(<params>\n) {\n<body>\n}`, and the parameters and the body must each parse
/// on their own. One parse of the whole text proves that when the tree is that one function with
/// its parameters and its body exactly where the text put them; a piece that closes its own
/// bracket early (`a) {}; f(b`, `}); g(); (function () {`) moves one or the other.
pub fn parseFunction(a: Allocator, kind: FunctionKind, params: []const u8, body: []const u8) FunctionResult {
    const head = std.fmt.allocPrint(a, "{s} anonymous(", .{kind.prefix()}) catch oom();
    const src = std.mem.concat(a, u8, &.{ head, params, "\n) {\n", body, "\n}" }) catch oom();
    const params_start: u32 = @intCast(head.len);
    const params_end: u32 = @intCast(head.len + params.len);
    const body_start: u32 = params_end + @as(u32, "\n) ".len);
    const file = switch (parse(a, src, .script)) {
        .tree => |f| f,
        .syntax_error => |e| return .{ .syntax_error = e },
    };
    const stmts = file.root.data.source_file.stmts;
    const node = if (stmts.len == 1 and stmts[0].data == .func) stmts[0] else return .{ .syntax_error = early(params_end, "Arg string terminates parameters early") };
    const f = node.data.func;
    for (f.params) |p| {
        if (p.start < params_start or p.end > params_end) return .{ .syntax_error = early(params_end, "Arg string terminates parameters early") };
    }
    const block = f.body orelse return .{ .syntax_error = early(body_start, "Unexpected end of input") };
    if (block.start != body_start or block.end != src.len) return .{ .syntax_error = early(body_start, "Function body terminates early") };
    return .{ .function = .{ .file = file, .node = node } };
}

fn early(offset: u32, message: []const u8) SyntaxError {
    return .{ .offset = offset, .message = message };
}

fn oom() noreturn {
    @panic("out of memory");
}

const testing = std.testing;

fn expectTree(r: Result) !void {
    try testing.expect(r == .tree);
}

fn expectSyntaxError(r: Result) !void {
    try testing.expect(r == .syntax_error);
}

test "a script parses, a syntax error answers its offset" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectTree(parseScript(a, "let x = 1; x + 2;"));
    const r = parseScript(a, "let x = ;");
    try expectSyntaxError(r);
    try testing.expectEqual(@as(u32, 8), r.syntax_error.offset);
}

test "module declarations are a SyntaxError under the Script goal" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectSyntaxError(parseScript(a, "import x from 'y';"));
    try expectSyntaxError(parseScript(a, "export const x = 1;"));
    try expectSyntaxError(parseScript(a, "import.meta.url;"));
    try expectTree(parse(a, "import x from 'y'; export const z = x;", .module));
    // A dynamic import is an expression, which scripts may hold.
    try expectTree(parseScript(a, "import('y');"));
}

test "new Function's parameters and body parse separately" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expect(parseFunction(a, .normal, "a, b", "return a + b") == .function);
    try testing.expect(parseFunction(a, .normal, "", "") == .function);
    try testing.expect(parseFunction(a, .generator, "", "yield 1") == .function);
    try testing.expect(parseFunction(a, .async, "x = 1", "await x") == .function);
    try testing.expect(parseFunction(a, .async_generator, "...xs", "for await (const x of xs) yield x") == .function);
    // Each piece closing its own bracket would smuggle a second statement in.
    try testing.expect(parseFunction(a, .normal, "a) {}; (function (b", "") == .syntax_error);
    try testing.expect(parseFunction(a, .normal, "", "}); (function () {") == .syntax_error);
    // A comment opened in the parameters and closed in the body.
    try testing.expect(parseFunction(a, .normal, "/*", "*/) {") == .syntax_error);
    try testing.expect(parseFunction(a, .normal, "a b", "") == .syntax_error);
}
