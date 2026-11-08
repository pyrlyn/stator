//! Running a script (docs/INTERPRETER.md §1): parse, compile, run against the global object.

const std = @import("std");
const rt = @import("rt.zig");
const parse = @import("parse.zig");
const compile = @import("compile.zig");
const builtins = @import("builtins.zig");
const vm = @import("vm.zig");
const Value = rt.Value;
const c = rt.c;

pub const Outcome = union(enum) {
    /// The script's completion value, or undefined with the exception pending.
    value: Value,
    /// A construct the interpreter does not run yet; nothing ran.
    unsupported: struct { offset: u32, what: []const u8 },
};

/// ScriptEvaluation (§16.1.6). A syntax error is a pending SyntaxError, as an indirect `eval`
/// reports one; the tree is gone once the script is compiled, the templates stay for good.
pub fn runScript(src: []const u8, strict: bool) Outcome {
    return runCode(src, .script, .{ .strict = strict });
}

/// An indirect `eval`: an unsupported construct is an Error the script can see, never a silent
/// success.
pub fn evalScript(src: []const u8, strict: bool) Value {
    return settle(runScript(src, strict));
}

/// A binding of the compiled caller of a direct `eval` (`JSRTEvalBinding`, jsrt_interp.h).
pub const Binding = extern struct { name: [*:0]const u8, cell: *Value, constant: bool };

/// PerformEval (§19.2.1.1) for a direct call from compiled code: `x` is the call's first
/// argument, `this` the caller's, and `bindings` every binding the call can see.
pub fn evalDirect(x: Value, this: Value, bindings: []const Binding) Value {
    if (!rt.is(x, c.JSRT_TAG_STRING)) return x;
    const text = rt.sourceText(x) orelse return outOfMemory();
    defer std.c.free(text.ptr);
    return settle(runCode(text, .direct_eval, .{ .this = this, .bindings = bindings }));
}

/// CreateDynamicFunction (§20.2.1.1.1) for `Function(…)` and `new Function(…)`: a sloppy
/// function in the global scope, named `anonymous`.
pub fn newFunction(params: []const u8, body: []const u8) Value {
    var arena = scratch();
    defer arena.deinit();
    const a = arena.allocator();
    const f = switch (parse.parseFunction(a, .normal, params, body)) {
        .function => |f| f,
        .syntax_error => |e| return syntaxError(a, e.message),
    };
    const compiled = compile.compileDynamicFunction(a, std.heap.c_allocator, f.file, f.node) catch return outOfMemory();
    return switch (compiled) {
        .template => |t| vm.globalClosure(t),
        .unsupported => |u| unsupported(u.what),
        .syntax_error => |e| syntaxError(a, e.message),
    };
}

const Goal = enum { script, direct_eval };
const Context = struct {
    strict: bool = true,
    this: Value = rt.undefined_value,
    bindings: []const Binding = &.{},
};

/// The global object made, and an arena for one parse and compile: the tree dies with it, the
/// templates it produced are allocated elsewhere and stay.
fn scratch() std.heap.ArenaAllocator {
    builtins.init();
    return .init(std.heap.c_allocator);
}

fn runCode(src: []const u8, goal: Goal, cx: Context) Outcome {
    var arena = scratch();
    defer arena.deinit();
    const a = arena.allocator();
    const file = switch (parse.parseScript(a, src)) {
        .tree => |f| f,
        .syntax_error => |e| return .{ .value = syntaxError(a, e.message) },
    };
    const compiled = switch (goal) {
        .script => compile.compileScript(a, std.heap.c_allocator, file, cx.strict),
        .direct_eval => compileEval(a, file, cx.bindings),
    } catch return .{ .value = outOfMemory() };
    return switch (compiled) {
        .template => |t| .{ .value = switch (goal) {
            .script => vm.run(t, null, rt.undefined_value, builtins.global(), &.{}, rt.undefined_value),
            .direct_eval => vm.runEval(t, cellsOf(a, cx.bindings) catch return .{ .value = outOfMemory() }, cx.this),
        } },
        .unsupported => |u| .{ .unsupported = .{ .offset = u.offset, .what = u.what } },
        .syntax_error => |e| .{ .value = syntaxError(a, e.message) },
    };
}

fn compileEval(a: std.mem.Allocator, file: *parse.File, bindings: []const Binding) compile.Error!compile.Compiled {
    const outer = try a.alloc(compile.Outer, bindings.len);
    for (outer, bindings) |*o, b| o.* = .{ .name = std.mem.span(b.name), .constant = b.constant };
    return compile.compileEval(a, std.heap.c_allocator, file, outer);
}

fn cellsOf(a: std.mem.Allocator, bindings: []const Binding) ![]const *Value {
    const cells = try a.alloc(*Value, bindings.len);
    for (cells, bindings) |*cell, b| cell.* = b.cell;
    return cells;
}

/// The value an outcome answers, an unsupported construct thrown as an Error.
fn settle(out: Outcome) Value {
    return switch (out) {
        .value => |v| v,
        .unsupported => |u| unsupported(u.what),
    };
}

fn unsupported(what: []const u8) Value {
    var buf: [160]u8 = undefined;
    const msg = std.fmt.bufPrintSentinel(&buf, "not supported by the interpreter yet: {s}", .{what}, 0) catch "not supported by the interpreter yet";
    rt.c.jsrt_throw_error(&rt.c.jsrt_class_error, msg.ptr);
    return rt.undefined_value;
}

fn syntaxError(a: std.mem.Allocator, message: []const u8) Value {
    const msg = a.dupeSentinel(u8, message, 0) catch "syntax error";
    rt.throwSyntax(msg.ptr);
    return rt.undefined_value;
}

fn outOfMemory() Value {
    rt.throwRange("out of memory compiling the script");
    return rt.undefined_value;
}

fn expectRuns(src: []const u8, want: []const u8) !void {
    rt.c.jsrt_init();
    const out = runScript(src, false);
    try std.testing.expect(out == .value);
    if (rt.pending()) {
        const e = rt.c.jsrt_take_exception();
        const p = rt.c.jsrt_shape_key_ephemeral(rt.c.jsrt_to_string(e));
        defer std.c.free(p);
        std.debug.print("uncaught: {s}\n", .{std.mem.span(p)});
        return error.Uncaught;
    }
    const p = rt.c.jsrt_shape_key_ephemeral(rt.c.jsrt_to_string(out.value));
    defer std.c.free(p);
    try std.testing.expectEqualStrings(want, std.mem.span(p));
}

test "arithmetic and bindings" {
    try expectRuns("let x = 2; const y = 3; var z = x * y + 1; z", "7");
    try expectRuns("'a' + 1 + 2", "a12");
    try expectRuns("7 % -3", "1");
    try expectRuns("2 ** 10", "1024");
    try expectRuns("typeof undeclared", "undefined");
}

test "functions and closures" {
    try expectRuns("function f(a, b = 2) { return a + b; } f(1)", "3");
    try expectRuns("const add = (a) => (b) => a + b; add(2)(3)", "5");
    try expectRuns("function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } fib(15)", "610");
    try expectRuns("function r(...xs) { return xs.length; } r(1, 2, 3)", "3");
    try expectRuns("function g() { return arguments.length; } g(1, 2)", "2");
    try expectRuns("let fs = []; for (let i = 0; i < 3; i++) fs.push(() => i); fs[0]() + fs[2]()", "2");
}

test "control flow" {
    try expectRuns("let s = 0; for (let i = 0; i < 10; i++) { if (i % 2) continue; s += i; } s", "20");
    try expectRuns("let n = 0; outer: for (;;) { for (;;) { n++; break outer; } } n", "1");
    try expectRuns("let k = ''; switch (2) { case 1: k = 'a'; case 2: k += 'b'; case 3: k += 'c'; break; default: k = 'd'; } k", "bc");
    try expectRuns("let i = 0; do { i++; } while (i < 5); i", "5");
}

test "exceptions" {
    try expectRuns("let r; try { throw new TypeError('x'); } catch (e) { r = e instanceof TypeError; } r", "true");
    try expectRuns("let log = ''; function f() { try { return 'a'; } finally { log += 'f'; } } f() + log", "af");
    try expectRuns("let m; try { null.x; } catch (e) { m = e.constructor === TypeError; } m", "true");
    try expectRuns("let m; try { x; let x = 1; } catch (e) { m = e instanceof ReferenceError; } m", "true");
}

test "objects, arrays and destructuring" {
    try expectRuns("const o = { a: 1, get b() { return this.a + 1; } }; o.b", "2");
    try expectRuns("const { a, ...rest } = { a: 1, b: 2, c: 3 }; Object.keys(rest).join()", "b,c");
    try expectRuns("const [x, , y = 9, ...z] = [1, 2, undefined, 4, 5]; x + y + z.length", "12");
    try expectRuns("[...'abc', ...[1, 2]].length", "5");
    try expectRuns("let s = 0; for (const v of [1, 2, 3]) s += v; s", "6");
    try expectRuns("let ks = ''; for (const k in { p: 1, q: 2 }) ks += k; ks", "pq");
    try expectRuns("const o = { x: { y: null } }; String(o.x?.y?.z)", "undefined");
}

test "classes" {
    try expectRuns(
        \\class A { #n = 1; constructor(v) { this.v = v; } get n() { return this.#n; } static s() { return 'S'; } }
        \\class B extends A { constructor() { super(5); } m() { return super.constructor.name; } }
        \\const b = new B(); b.v + b.n + A.s() + (b instanceof A)
    , "6Strue");
    try expectRuns("class C { static x = 3; static { C.y = C.x * 2; } } C.y", "6");
    try expectRuns("let m; try { class D {} D(); } catch (e) { m = e instanceof TypeError; } m", "true");
}

test "iterators" {
    try expectRuns(
        \\const it = { [Symbol.iterator]() { let i = 0; return { next() { i++; return { value: i, done: i > 3 }; }, return() { log += 'closed'; return {}; } }; } };
        \\var log = ''; let s = 0; for (const v of it) { s += v; if (v === 2) break; } s + log
    , "3closed");
}

test "functions as values" {
    try expectRuns("function f(a, b) { return this.k + a + b; } f.call({ k: 1 }, 2, 3) + f.apply({ k: 1 }, [2, 3])", "12");
    try expectRuns("function f(a, b) { return a + b; } const g = f.bind(null, 1); g(2) + g.name + g.length", "3bound f1");
    try expectRuns("function P(x) { this.x = x; } const B = P.bind(null, 7); new B().x", "7");
    try expectRuns("class C { static name() { return 'n'; } } typeof C.name", "function");
    try expectRuns("[].constructor === Array && ({}).constructor === Object", "true");
    try expectRuns("eval('1 + 2')", "3");
    try expectRuns("'abcb'.replace('b', (m, i) => m.toUpperCase() + i) + 'ab'.replaceAll('', '-')", "aB1cb-a-b-");
    try expectRuns("Object.hasOwn([1, , 3], 1) + ',' + Object.hasOwn('ab', '1') + ',' + (function f() {}).hasOwnProperty('prototype')", "false,true,true");
}

test "early errors the parser leaves to the compiler" {
    rt.c.jsrt_init();
    _ = runScript("switch (1) { default: default: }", false);
    try std.testing.expect(rt.pending());
    try std.testing.expect(rt.c.jsrt_is_error(rt.c.jsrt_take_exception()));
}

test "unsupported constructs are reported, not run" {
    rt.c.jsrt_init();
    const out = runScript("function* g() {}", false);
    try std.testing.expect(out == .unsupported);
}

test "syntax errors are pending SyntaxErrors" {
    rt.c.jsrt_init();
    _ = runScript("let = = ;", false);
    try std.testing.expect(rt.pending());
    const e = rt.c.jsrt_take_exception();
    try std.testing.expect(rt.c.jsrt_is_error(e));
}

test "prototype methods called through call" {
    try expectRuns("Array.prototype.map.call({ length: 2, 0: 'a', 1: 'b' }, (x) => x + x).join() + String.prototype.slice.call(123, 1)", "aa,bb23");
    try expectRuns("const s = Symbol('k'); const o = { a: 1, [s]: 2 }; Object.keys(o).length + ',' + Object.getOwnPropertySymbols(o).length + ',' + (Object.getOwnPropertySymbols(o)[0] === s)", "1,1,true");
    try expectRuns("let m; try { Array.prototype.push.call({ length: 0 }, 1); } catch (e) { m = e instanceof TypeError; } m", "true");
}

test "a direct eval reads and writes its caller's bindings through their cells" {
    rt.c.jsrt_init();
    var x = rt.number(2);
    var k = rt.string("k");
    const bindings = [_]Binding{ .{ .name = "x", .cell = &x, .constant = false }, .{ .name = "k", .cell = &k, .constant = true } };
    const out = evalDirect(rt.string("var local = 40; x = x * 10 + local; x + k"), rt.undefined_value, &bindings);
    try std.testing.expect(!rt.pending());
    try std.testing.expectEqual(@as(f64, 60), rt.c.jsrt_to_number(x));
    try std.testing.expectEqualStrings("60k", std.mem.span(rt.c.jsrt_shape_key_ephemeral(out)));
    // A closure the eval code makes keeps reading the cell after the eval returns.
    const f = evalDirect(rt.string("() => x + 1"), rt.undefined_value, &bindings);
    x = rt.number(7);
    try std.testing.expectEqual(@as(f64, 8), rt.c.jsrt_to_number(vm.call(f, rt.undefined_value, &.{})));
    // Strict eval code: its `var`s vanish, a constant is not assignable, and a non-string
    // argument is the result.
    _ = evalDirect(rt.string("k = 1"), rt.undefined_value, &bindings);
    try std.testing.expect(rt.pending());
    _ = rt.c.jsrt_take_exception();
    try std.testing.expect(evalDirect(rt.number(5), rt.undefined_value, &bindings) == rt.number(5));
    _ = evalDirect(rt.string("local"), rt.undefined_value, &bindings);
    try std.testing.expect(rt.pending());
    _ = rt.c.jsrt_take_exception();
}

test "eval source text may hold U+0000" {
    rt.c.jsrt_init();
    const src = [_]u16{ '"', 'a', 0, 'b', '"', '.', 'l', 'e', 'n', 'g', 't', 'h' };
    const out = evalDirect(rt.c.jsrt_string_from_units(&src, src.len), rt.undefined_value, &.{});
    try std.testing.expect(!rt.pending());
    try std.testing.expectEqual(@as(f64, 3), rt.c.jsrt_to_number(out));
}

test "new Function builds a global function" {
    try expectRuns("const f = new Function('a', 'b', 'return a + b'); f(2, 3) + f.name + f.length", "5anonymous2");
    try expectRuns("Function('return typeof this')()", "object");
    try expectRuns("let m; try { Function('a) {}; (function (b', ''); } catch (e) { m = e instanceof SyntaxError; } m", "true");
}
