//! Running a script (docs/INTERPRETER.md §1): parse, compile, run against the global object.

const std = @import("std");
const rt = @import("rt.zig");
const parse = @import("parse.zig");
const compile = @import("compile.zig");
const builtins = @import("builtins.zig");
const vm = @import("vm.zig");
const jit = @import("jit/jit.zig");
const helpers = @import("jit/helpers.zig");
const lower = @import("jit/lower.zig");
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

fn runOk(src: []const u8) !Value {
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
    return out.value;
}

/// Runs `src` in both of the engine's modes: the JIT must answer what the interpreter answers.
fn expectRuns(src: []const u8, want: []const u8) !void {
    inline for (.{ jit.Mode.interp, jit.Mode.jit }) |m| {
        jit.mode = m;
        defer jit.mode = .interp;
        const v = try runOk(src);
        const p = rt.c.jsrt_shape_key_ephemeral(rt.c.jsrt_to_string(v));
        defer std.c.free(p);
        std.testing.expectEqualStrings(want, std.mem.span(p)) catch |e| {
            std.debug.print("mode {s}: {s}\n", .{ @tagName(m), src });
            return e;
        };
    }
}

test "the JIT compiles numeric functions and calls them" {
    if (!jit.available) return error.SkipZigTest;
    const before = jit.compiled;
    try expectRuns("function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } fib(20)", "6765");
    try expectRuns("function sum(n) { let s = 0; for (let i = 0; i < n; i++) s += i * 0.5; return s; } sum(1000)", "249750");
    try std.testing.expect(jit.compiled >= before + 2);
}

/// The calls helper `fs[k]` has received so far (helpers.Counter; test builds only).
fn helperCalls(comptime fs: anytype) [fs.len]usize {
    var out: [fs.len]usize = undefined;
    inline for (fs, 0..) |f, k| out[k] = helpers.Counter(f).n;
    return out;
}

/// What `src` cost under the JIT: templates compiled and calls into each of `fs`.
/// `entries` counts native code entered from the interpreter, which a call between compiled
/// functions skips.
fn jitCost(src: []const u8, comptime fs: anytype) !struct { compiled: usize, entries: usize, calls: [fs.len]usize } {
    jit.mode = .jit;
    defer jit.mode = .interp;
    const compiled = jit.compiled;
    const entries = jit.entries;
    const before = helperCalls(fs);
    _ = try runOk(src);
    var calls = helperCalls(fs);
    for (&calls, before) |*n, b| n.* -= b;
    return .{ .compiled = jit.compiled - compiled, .entries = jit.entries - entries, .calls = calls };
}

test "a JS call reaches the call helper once and nothing else per call" {
    if (!jit.available) return error.SkipZigTest;
    const r = try jitCost(
        "function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } fib(20)",
        .{ helpers.call, helpers.loadGlobal, helpers.retCtor, helpers.binary, helpers.home },
    );
    // The script and fib, each compiled on its first call and never again.
    try std.testing.expectEqual(2, r.compiled);
    // The interpreter enters the script and fib's first call, which compiles it; every
    // recursive call goes from compiled code straight into compiled code.
    try std.testing.expectEqual(2, r.entries);
    // fib(20) makes 21891 calls; each one is exactly one helper call.
    try std.testing.expectEqual(21891, r.calls[0]);
    // The cache is per template and key: fib's two reads share one, which misses once. The
    // script's read hits, its declaration of `fib` having filled the script's cache.
    try std.testing.expectEqual(1, r.calls[1]);
    // A plain call returns inline and doubles add and compare inline. The one home object is
    // the script prologue's; fib's is never read, so it is never fetched.
    try std.testing.expectEqual([3]usize{ 0, 0, 1 }, r.calls[2..5].*);
}

test "a numeric loop runs without a helper" {
    if (!jit.available) return error.SkipZigTest;
    const r = try jitCost(
        "function f() { let s = 0; for (let i = 0; i < 1000; i++) { s += i * 0.5; s -= 1; s = -s; } return s; } f()",
        .{ helpers.unary, helpers.binary, helpers.call },
    );
    try std.testing.expectEqual(2, r.compiled);
    // `i++`, `+=`, `*`, `-=`, unary `-` and `<` on doubles are all inline; the one call is f's.
    try std.testing.expectEqual([3]usize{ 0, 0, 1 }, r.calls);
}

test "the fast chain leaves for the generic code on anything but the doubles it expects" {
    // Strings and objects where the chain guards for doubles; remainders that are -0,
    // NaN or fractional; NaN comparisons, fused with their jump and not; a TDZ read and write
    // after the chain has stored; a value whose type changes inside a loop.
    try expectRuns("function f(a) { let s = a; for (let i = 0; i < 5; i += 1) s = s + i; return s; } f('x') + f(1)", "x0123411");
    try expectRuns("function f(a, b) { return a % b; } [Object.is(f(-4, 2), -0), Object.is(f(4, 2), 0), Object.is(f(-0, 3), -0), Object.is(f(0, 3), 0), f(5, 0), f(5.5, 2), f(-7, 3), f(7, -3), f(2 ** 53, 3), f(Infinity, 2), f(3, Infinity), f(NaN, 2), f('7', 4)].join()", "true,true,true,true,NaN,1.5,-1,1,2,NaN,3,NaN,3");
    try expectRuns("function f(a, b) { let n = 0; if (a < b) n += 1; if (a >= b) n += 2; if (a == b) n += 4; if (a != b) n += 8; if (a === b) n += 16; if (a !== b) n += 32; if (a > b) n += 64; if (a <= b) n += 128; return n; } [f(1, 2), f(2, 1), f(1, 1), f(NaN, 1), f(NaN, NaN), f(0, -0), f('1', 1), f(null, undefined), f(null, 0)].join()", "169,106,150,40,40,150,166,36,170");
    try expectRuns("function f(a, b) { const x = a < b; const y = (a >= b) + 1; let i = 0; do { i += 1; } while (i < b); return [x, y, i, a < b || a, a > b && b].join(); } f(1, 3) + ';' + f(3, 1) + ';' + f(NaN, 2)", "true,1,3,true,false;false,2,1,3,1;false,1,2,NaN,false");
    try expectRuns("function f() { let s = 1; try { s = s + y; } catch (e) { return s + ':' + (e instanceof ReferenceError); } let y = 2; return s; } f()", "1:true");
    try expectRuns("function f() { let s = 1; try { s = s + 2; y = s; } catch (e) { return s + ':' + (e instanceof ReferenceError); } let y = 2; return s; } f()", "3:true");
    try expectRuns("function f(x) { let a = x; a++; ++a; a--; let b = a++ + ++a; return a + ',' + b; } f(1) + ';' + f('1') + ';' + f(1.5)", "4,6;4,6;4.5,7");
    try expectRuns("function f() { let a = 5; let b = a; a = 7; const c = a; a = a + c; return a + b * 2; } f()", "24");
    try expectRuns("function f(o) { let s = 1; s = s + 2; s = s + o; s = s * 2; return s; } f(3) + ',' + f('a') + ',' + f({ valueOf() { return 4; } })", "12,NaN,14");
    try expectRuns("function f() { let s = 0; for (let i = 0; i < 6; i += 1) { if (i == 3) s = s + 'x'; s = s + i; } return s; } f()", "3x345");
    try expectRuns("function f(n) { let sum = 0; for (let i = 0; i < n; i += 1) sum = (sum + i) % 65521; return sum; } f(10000) + ',' + f(0) + ',' + f(-1)", "2477,0,0");
    // Remainders that take the dividend, one subtraction or the division; a divisor that is
    // negative, zero, infinite or NaN.
    try expectRuns("function f(a, b) { return a % b; } [f(3, 5), f(7, 5), f(5, 5), f(12, 5), f(2.5, 4), f(5.75, 4), f(0.5, 0.3), f(9.5, 0.3), Object.is(f(-0, 5), -0), Object.is(f(0, 5), 0), f(3, -5), f(7, -5), f(0, -3), f(3, Infinity), f(Infinity, Infinity), f(7, NaN), f(NaN, NaN), f(1e308, 6e307), f(1e-323, 5e-324), f(2 ** 53, 2 ** 52), f(-3, 5), f(4, 0), f(0, 0)].join()", "3,2,0,2,2.5,1.75,0.2,0.20000000000000034,true,true,3,2,0,3,NaN,NaN,NaN,4.0000000000000004e+307,0,0,-3,NaN,NaN");
    try expectRuns("function f(n) { let i = 0; let c = 0; let s = 0; let d = 0; for (let k = 0; k < n; k += 1) { i = (i + 1) % 7; c += i; s = (s + k * 1000) % 97; d = (d - k) % 5; } return [c, i, s, d].join(); } f(100) + ';' + f(0) + ';' + f(3)", "297,2,90,0;0,0,0,0;6,3,90,-3");
    try expectRuns("function f(a, b) { let q = a / b; let p = a * b - q; return [q, p, a - b, 1 / (a * 0), a / 0 - a / 0].join(); } f(6, 4) + ';' + f(-1, 2)", "1.5,22.5,2,Infinity,NaN;-0.5,-1.5,-3,-Infinity,NaN");
    try expectRuns("function f(a) { let s = 0; for (let i = a; i < 4; i += 1) s += i; return s; } f(0) + ',' + f('2') + ',' + f(-0.5)", "6,02,7.5");
}

test "a loop that carries its locals in registers answers what the window would" {
    // Two carried locals exchanged; nested loops; break and continue; a boolean local as the
    // condition; operands that cross a block; -0 and NaN; a local that arrives or turns into
    // something other than a double; a loop counting down and one that halves.
    try expectRuns("function f(n) { let a = 0; let b = 1; for (let i = 0; i < n; i += 1) { const t = a + b; a = b; b = t; } return a; } f(50) + ',' + f(0) + ',' + f(1)", "12586269025,0,1");
    try expectRuns("function f(n) { let a = 1; let b = 2; let i = 0; while (i < n) { let t = a; a = b; b = t; i += 1; } return a + ',' + b; } f(3) + ';' + f(4)", "2,1;1,2");
    try expectRuns("function f(n) { let s = 0; for (let i = 0; i < n; i += 1) { for (let j = 0; j < i; j += 1) { s = s + i * j; } } return s; } f(20)", "16815");
    try expectRuns("function f(n) { let s = 0; let i = 0; while (true) { i += 1; if (i > n) break; if (i % 3 == 0) continue; s = s + i; } return s + ',' + i; } f(10)", "37,11");
    try expectRuns("function f() { let n = 0; let go = true; while (go) { n += 1; go = n < 10; } return n; } f()", "10");
    try expectRuns("function f(n) { let s = 0; for (let i = 0; i < n; i += 1) s = s + (i % 2 == 0 ? 1 : 0.5); return s; } f(7)", "5.5");
    try expectRuns("function f(n) { let x = 1; for (let i = 0; i < n; i += 1) x = x * -0; return Object.is(x, -0) + ',' + Object.is(x * -1, 0); } f(1) + ';' + f(2)", "true,true;false,false");
    try expectRuns("function f(a, n) { let s = a; let k = 0; for (let i = 0; i < n; i += 1) { s = s + i; k = k + 2; } return s + ',' + k; } f(0.5, 4) + ';' + f('s', 4) + ';' + f(null, 4) + ';' + f(undefined, 2)", "6.5,8;s0123,8;6,8;NaN,4");
    try expectRuns("function f(n) { let s = 0; let o = 1; for (let i = 0; i < n; i += 1) { if (i == 2) o = 'q'; s = s + o; } return s; } f(5)", "2qqq");
    try expectRuns("function f(n) { let x = 0; let y = 0 / 0; let c = 0; do { x += 1; if (x < y) c += 1; if (x >= y) c += 10; if (x != y) c += 100; } while (x < n); return c + ',' + x; } f(3)", "300,3");
    try expectRuns("function f(n) { let i = n; let s = 0; while (i > 0) { s = s + i; i = i - 1; } return s + ',' + i; } f(4) + ';' + f(2.5) + ';' + f(-1)", "10,0;4.5,-0.5;0,-1");
    try expectRuns("function f(n) { let lo = 0; let hi = n; while (lo < hi) { const mid = (lo + hi - (lo + hi) % 2) / 2; if (mid * mid < n) lo = mid + 1; else hi = mid; } return lo; } f(1000) + ',' + f(2)", "32,2");
}

test "a remainder loop runs without a helper" {
    if (!jit.available) return error.SkipZigTest;
    const r = try jitCost(
        "function f(n) { let sum = 0; for (let i = 0; i < n; i += 1) sum = (sum + i) % 65521; return sum; } f(10000)",
        .{ helpers.binary, helpers.truthy },
    );
    try std.testing.expectEqual(2, r.compiled);
    // No dividend here reaches twice the divisor, so nothing is divided either.
    try std.testing.expectEqual([2]usize{ 0, 0 }, r.calls);
}

test "a cached property read misses once per site" {
    if (!jit.available) return error.SkipZigTest;
    const r = try jitCost(
        "function f(o) { let s = 0; for (let i = 0; i < 1000; i++) s += o.a + o.b; return s; } f({ a: 1, b: 2 })",
        .{ helpers.getProp, helpers.call, helpers.binary },
    );
    try std.testing.expectEqual(2, r.compiled);
    // Two sites, 1000 reads each: the first read of each fills its cache.
    try std.testing.expectEqual([3]usize{ 2, 1, 0 }, r.calls);
}

test "an object literal takes its cached shape steps in place" {
    if (!jit.available) return error.SkipZigTest;
    const r = try jitCost(
        "function f() { let s = 0; for (let i = 0; i < 1000; i++) { const o = {x: i, y: 2}; s += o.x + o.y; } return s; } f()",
        .{ helpers.define, helpers.getProp, helpers.newObject },
    );
    // On the fast chain both shape steps are taken when f is compiled, and what the literal
    // stored is read back without asking the object. Elsewhere the first literal finds its steps
    // and fills its read caches through the helpers, and the other 999 store and read inline.
    const first: usize = if (lower.fast_chain) 0 else 2;
    try std.testing.expectEqualSlices(usize, &.{ first, first }, r.calls[0..2]);
    // The chain also takes each object from the collector's open run itself, and calls the
    // allocator only where a run ends; the others call it for every literal.
    if (lower.fast_chain) try std.testing.expect(r.calls[2] < 100) else try std.testing.expectEqual(1000, r.calls[2]);
    try expectRuns("function f(k) { const o = {a: 1, b: 2, a: 3, [k]: 4, c: 5}; return JSON.stringify(o); } f('z') + f('b')", "{\"a\":3,\"b\":2,\"z\":4,\"c\":5}{\"a\":3,\"b\":4,\"c\":5}");
    try expectRuns("function f(p) { const o = {a: 1, __proto__: p, ...p, b: 2, m() { return this.a + this.b + this.q; }}; o.late = 1; o.later = 2; return o.m() + Object.keys(o).join(); } f({q: 4}) + f({q: 5, a: 7})", "7a,q,b,m,late,later14a,q,b,m,late,later");
    try expectRuns("function f(n) { const o = {a: n}; if (n & 1) o.b = n; else o.c = n; o.d = 1; o.e = 2; o.f = 3; return Object.keys(o).join('') + o.a; } f(1) + f(2) + f(3)", "abdef1acdef2abdef3");
    try expectRuns("class P { x = 1; y = 2; } class Q extends P { z = this.x + this.y; } function f() { const q = new Q(); return q.x + q.y + q.z; } f() + f()", "12");
}

test "a local read after its declaration takes no TDZ check, and any other read does" {
    // A read before the declaration, in a later clause of a `switch`, in the next iteration,
    // in its own initializer and by assignment; a constant and a class; a captured variable,
    // which a closure or a hoisted function may reach first; `this` before `super()`; a
    // `continue` past the declaration; a clause entered past it; reads that need no check.
    try expectRuns("function f() { try { x; } catch (e) { return e.name; } let x = 1; return x; } f()", "ReferenceError");
    try expectRuns("function f(n) { switch (n) { case 0: let y = 1; return y; case 1: try { return y; } catch (e) { return e.name; } } } f(0) + ',' + f(1)", "1,ReferenceError");
    try expectRuns("function f() { const out = []; for (let i = 0; i < 2; i += 1) { try { out.push(v); } catch (e) { out.push(e.name); } let v = i; out.push(v); } return out.join(); } f()", "ReferenceError,0,ReferenceError,1");
    try expectRuns("function f() { try { let x = x + 1; return x; } catch (e) { return e.name; } } f()", "ReferenceError");
    try expectRuns("function f() { try { z = 1; } catch (e) { return e.name; } let z; return z; } function g() { let z; z = 2; z += 1; return z; } f() + ',' + g()", "ReferenceError,3");
    try expectRuns("function f() { const c = 1; try { c = 2; } catch (e) { return e.name + c; } } function g() { try { c = 2; } catch (e) { return e.name; } const c = 1; } f() + ',' + g()", "TypeError1,ReferenceError");
    try expectRuns("function f() { try { new C(); } catch (e) { return e.name; } class C {} return typeof C; } function g() { class C {} return typeof new C(); } f() + ',' + g()", "ReferenceError,object");
    try expectRuns("function f() { const g = () => x; try { g(); } catch (e) { return e.name; } let x = 1; } function h() { try { return g(); } catch (e) { return e.name; } let x = 1; function g() { return x; } } f() + ',' + h()", "ReferenceError,ReferenceError");
    try expectRuns("let r = ''; class A {} class B extends A { constructor() { try { this.x = 1; } catch (e) { r = e.name; } super(); this.x = 2; } } r + new B().x + r", "2ReferenceError");
    try expectRuns("function f() { let n = 0; outer: for (let i = 0; i < 3; i += 1) { if (i === 1) continue outer; let k = i; n += k; } return n; } f()", "2");
    try expectRuns("function f() { const out = []; for (let i = 0; i < 3; i += 1) { switch (i) { case 1: try { out.push(q); } catch (e) { out.push('R'); } break; case 0: case 2: let q = i; out.push(q); } } return out.join(); } f()", "0,R,2");
    try expectRuns("function f(a) { let s = 0; for (const x of a) { const y = x * 2; s += y; } { let t = s; t += 1; s = t; } return s; } f([1, 2, 3])", "13");
}

test "a literal the fast chain follows answers what the object would" {
    // Members read back through locals, operands and a cycle; a key named twice, an own key
    // written, a key added and a key it lacks; two names for one object; an object a call, a
    // getter or Object.freeze has reached; members that are calls, literals and remainders;
    // `constructor` and `__proto__`; more members than the chain follows, none and a spread;
    // literals in a loop, in a list and in a cycle; a literal that outlives collections and is
    // then written with younger objects; captured variables read and written between members.
    try expectRuns("function f(i, seed) { const a = { value: i, next: null }; const b = { value: seed, next: a }; a.next = b; return a.next.value + b.next.value + ',' + (a.next === b) + ',' + (b.next.next === b) + ',' + a.next.next.value; } f(1, 2) + ';' + f('x', 0.5) + ';' + f(-0, NaN)", "3,true,true,1;0.5x,true,true,x;NaN,true,true,0");
    try expectRuns("function f(k) { const o = { a: 1, b: k, a: k + 1 }; const r = [o.a, o.b]; o.b = o.a * 2; r.push(o.b, o.c); o.c = 7; r.push(o.c, 'c' in o); return r.join() + JSON.stringify(o); } f(1) + f('s')", "2,1,4,,7,true{\"a\":2,\"b\":4,\"c\":7}s1,s,NaN,,7,true{\"a\":\"s1\",\"b\":null,\"c\":7}");
    try expectRuns("function f(n) { const a = { x: n, y: 0 }; const b = a; b.x = n + 1; const v = (a.y = b.x * 2); return [a.x, b.y, v, { p: n, q: a }.q.x, { p: n }.p].join(); } f(1) + ';' + f(2.5)", "2,4,4,2,1;3.5,7,7,3.5,2.5");
    try expectRuns("function g(o) { o.x = o.x + 10; o.z = 1; delete o.y; return o; } function f(n) { const o = { x: n, y: 2 }; const before = o.x + o.y; g(o); return before + ',' + o.x + ',' + o.y + ',' + o.z + ',' + Object.keys(o).join(''); } f(1) + ';' + f(5)", "3,11,undefined,1,xz;7,15,undefined,1,xz");
    try expectRuns("function f(n) { let c = 0; const o = { x: n, get y() { c += 1; return this.x * 2; }, z: 3 }; const p = { a: o.x, b: 4 }; return [o.x, o.y, o.y, o.z, c, p.a, p.b].join(); } f(1) + ';' + f(2)", "1,2,2,3,2,1,4;2,4,4,3,2,2,4");
    try expectRuns("function f(n) { 'use strict'; const o = { x: n, y: 1 }; o.y = n + 1; Object.freeze(o); let threw = false; try { o.x = 9; } catch (e) { threw = e instanceof TypeError; } return o.x + ',' + o.y + ',' + threw; } f(1)", "1,2,true");
    try expectRuns("function h(x) { return { v: x }; } function f(n, s) { const o = { a: h(n).v, b: { c: n + 1, d: s + n }, e: n % 3 }; return [o.a, o.b.c, o.b.d, o.e, o.b === o.b].join(); } f(4, 1) + ';' + f(4, 'q') + ';' + f(-3, 1)", "4,5,5,1,true;4,5,q4,1,true;-3,-2,-2,0,true");
    try expectRuns("function f(p) { const a = { constructor: 1, x: 2 }; const b = { x: 3, y: 4 }; const __proto__ = p; const d = { __proto__, x: 5 }; const e = { __proto__: p, x: 6 }; return [a.constructor, b.constructor === Object, d.__proto__ === p, Object.getPrototypeOf(d) === Object.prototype, e.q, e.x, Object.keys(d).join('')].join(); } f({ q: 9 })", "1,true,true,true,9,6,__proto__x");
    try expectRuns("function f(n) { const o = { a: n, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 }; const e = {}; e.k = o.j; const s = { ...o, a: 0, z: e.k }; return o.a + o.j + e.k + s.a + s.z + Object.keys(s).length; } f(1)", "42");
    try expectRuns("let root = null; function f(n) { let sum = 0; let head = null; for (let i = 0; i < n; i += 1) { const a = { value: i, next: null }; const b = { value: n, next: a }; a.next = b; root = a; head = { value: i, next: head }; sum += a.next.value + b.next.value + head.value; } let len = 0; for (let p = head; p !== null; p = p.next) len += 1; return sum + ',' + len + ',' + root.next.next.value; } f(2000) + ';' + f(3)", "7998000,2000,1999;15,3,2");
    try expectRuns("function fill(n) { const junk = []; for (let i = 0; i < n; i += 1) junk.push({ i, s: 'k' + i }); return junk.length; } function f(n) { const keep = { first: null, second: null, count: 0 }; const a = { v: 1, w: null }; keep.count = fill(n); const b = { v: 2, w: a }; keep.first = b; a.w = keep; keep.count += fill(n); const c = { v: 3, w: keep.first }; keep.second = c; keep.count += fill(n); return [keep.first.v, keep.second.v, keep.second.w.w.v, a.w.count, keep.first.w.w === keep].join(); } f(3000)", "2,3,1,9000,true");
    try expectRuns("function f(n) { let seen = 0; const bump = () => { seen += 1; return seen; }; const o = { a: n, b: seen }; seen = o.a + 1; const p = { a: seen, b: o }; bump(); return [o.a, o.b, p.a, p.b.a, seen].join(); } f(4)", "4,0,5,4,6");
    // Captured variables a closure also writes, one and two environments out; literals of
    // every size the chain allocates itself, enough of them to fill runs and outlive collections.
    try expectRuns("function f(n) { let total = 0; let last = null; const add = (o) => { total += o.v; }; for (let i = 0; i < n; i += 1) { const o = { v: i, w: total }; last = o; add(o); total = total + 1; } return total + ',' + last.v + ',' + last.w; } f(100)", "5050,99,4950");
    try expectRuns("function outer(n) { let a = 1; function mid() { let b = 2; function inner(k) { a = a + k; b = b + a; const o = { p: a, q: b }; return o.p + o.q; } let s = 0; for (let i = 0; i < n; i += 1) s += inner(i); return s + ',' + b; } return mid() + ',' + a; } outer(50)", "292975,20877,1226");
    try expectRuns("function f(n) { const keep = []; for (let i = 0; i < n; i += 1) { const a = { a: i }; const b = { a: i, b: a }; const c = { a: i, b: b, c: 3, d: 4, e: 5, f: 6, g: 7, h: a }; if (i % 97 === 0) keep.push(c); } let s = 0; for (const c of keep) s += c.a + c.b.b.a + c.h.a + c.g; return s + ',' + keep.length; } f(200000)", "618357715,2062");
    // A member that leaves the fast chain between two the chain stored, and a literal whose
    // members are a call that collects and literals that outlive it.
    try expectRuns("function f(n, s) { const o = { a: n, b: s + n, c: n * 2 }; o.d = s; return JSON.stringify(o) + Object.keys(o).join(''); } f(1, 2) + f(1, 'x') + f('y', 2)", "{\"a\":1,\"b\":3,\"c\":2,\"d\":2}abcd{\"a\":1,\"b\":\"x1\",\"c\":2,\"d\":\"x\"}abcd{\"a\":\"y\",\"b\":\"2y\",\"c\":null,\"d\":2}abcd");
    try expectRuns("function fill(n) { const junk = []; for (let i = 0; i < n; i += 1) junk.push({ i, s: 'k' + i }); return junk.length; } function f(n) { const first = { x: n, y: null }; const o = { a: first, b: fill(n), c: { z: first } }; first.y = o; let live = 0; for (let i = 0; i < 300000; i += 1) { const t = { p: i, q: o, r: null }; t.r = t; if (t.q.c.z.y === o) live += 1; } return [o.b, o.a.x, o.c.z.y.b, live].join(); } f(3000)", "3000,3000,3000,300000");
}

test "a value that waits for the frame window is there when the chain is left" {
    // Locals and operands computed before a guard that fails; a comparison's result and a
    // popped operand; a loop with carried locals left in the middle of an iteration; doubles
    // that wait across the allocator's slow path, and across the remainder's division; the
    // constants that are no number.
    try expectRuns("function f(a, b) { let x = a + 1; let y = x * 2; let z = y - a; x = z; return z + b + ',' + x + ',' + y; } f(1, 2) + ';' + f(1, 's') + ';' + f('q', 2) + ';' + f(1, 2)", "5,3,4;3s,3,4;NaN,NaN,NaN;5,3,4");
    try expectRuns("function f(a, b) { const c = a < b; const d = (a, b, a * b); let e = d; e = e + 1; e = e + c; return c + ',' + d + ',' + e; } f(1, 2) + ';' + f(2, 1) + ';' + f(2, 'x') + ';' + f(NaN, 1)", "true,2,4;false,2,3;false,NaN,NaN;false,NaN,NaN");
    try expectRuns("function f(n, k) { let s = 0; let t = 1; for (let i = 0; i < n; i += 1) { s += i; t = s * 2; if (i === 5) s = s + k; } return s + ',' + t; } f(10, 1) + ';' + f(10, 'x') + ';' + f(10, 1)", "46,92;15x6789,NaN;46,92");
    try expectRuns("function f(n) { let s = 0; let keep = null; for (let i = 0; i < n; i += 1) { const x = i * 2; const y = x + 1; const o = { a: x, b: y }; s += o.a + y; if (i % 1000 === 0) keep = o; } return s + ',' + keep.b + ',' + keep.a; } f(300000)", "179999700000,598001,598000");
    try expectRuns("function f(n, d) { let s = 0; for (let i = 0; i < n; i += 1) { const x = i * 3; const y = x + 1; s += (y * 1000) % d + x % 5 + (0 - y) % d; } return s; } f(1000, 7) + ';' + f(10, 0.5) + ';' + f(10, 0)", "2003;20;NaN");
    try expectRuns("function f(n) { let u; let a = 1; for (let i = 0; i < n; i += 1) { let v; const w = null; const o = { p: v, q: w, r: true }; a = a + 1; u = o; } return [u.p, u.q, u.r, a].join(); } f(50)", ",,true,51");
}

test "an array's length and its elements are read and written in place" {
    if (!jit.available) return error.SkipZigTest;
    const r = try jitCost(
        "function f(a) { let s = 0; for (let i = 0; i < a.length; i++) { a[i] = a[i] + 1; s += a[i]; } return s; } const a = []; for (let i = 0; i < 1000; i++) a.push(i); f(a)",
        .{ helpers.getProp, helpers.getElem, helpers.setElem, helpers.binary },
    );
    try std.testing.expectEqualSlices(usize, &.{ 0, 0, 0, 0 }, &r.calls);
    // A hole, an index outside the array, a fraction, a numeric string, -0 and NaN.
    try expectRuns("function f(a, k) { return String(a[k]); } const a = [1, , 3]; [0, 1, 2, 3, -1, 0.5, '2', -0, NaN, 4294967296].map((k) => f(a, k)).join()", "1,undefined,3,undefined,undefined,undefined,3,1,undefined,undefined");
    // A write at or past the end grows the array through the helper.
    try expectRuns("function f(a, k, v) { a[k] = v; return a.length; } const a = [1, 2]; [f(a, 0, 'a'), f(a, 2, 'b'), f(a, 5, 'c')].join() + JSON.stringify(a)", "2,3,6[\"a\",2,\"b\",null,null,\"c\"]");
    // Not arrays: a string and an object with index keys, and `length` of each.
    try expectRuns("function f(o, k) { return o[k] + ':' + o.length; } [f('abc', 1), f({ 1: 'p', length: 'q' }, 1), f([5, 6], 1)].join()", "b:3,p:q,6:2");
    // An element store keeps the collector's view of the array: old arrays take new objects.
    try expectRuns("function f(a, n) { for (let i = 0; i < a.length; i++) a[i] = { v: i + n }; } const a = [0, 0, 0, 0]; let s = 0; for (let n = 0; n < 300; n++) { f(a, n); s += a[3].v; } s", "45750");
}

test "an array method is bound once per activation" {
    if (!jit.available) return error.SkipZigTest;
    const r = try jitCost(
        "function f() { const a = []; for (let i = 0; i < 1000; i++) a.push(i); return a.length; } f()",
        .{ helpers.getMethod, helpers.getProp },
    );
    try std.testing.expectEqual(2, r.compiled);
    // The first `a.push` binds the method and caches it; the other 999 read the cache inline.
    // `a.length` is read in place.
    try std.testing.expectEqual([2]usize{ 1, 0 }, r.calls);
    const pushes = try jitCost(
        "function f(n) { const a = []; for (let i = 0; i < n; i++) a.push(i); return a.length + ':' + a[n - 1]; } f(1000)",
        .{helpers.call},
    );
    // The first push binds the method; the others reach the helper only to grow the array,
    // whose capacity doubles from 1.
    try std.testing.expectEqualSlices(usize, &.{11}, &pushes.calls);
    try expectRuns("function f(n) { const a = []; for (let i = 0; i < n; i++) a.push(i); return a.length + ':' + a[n - 1]; } f(1000)", "1000:999");
    // The result is the new length; two arguments, and a site that sees two arrays in turn.
    try expectRuns("function f() { const a = [1], b = [2]; let r = ''; for (let i = 0; i < 3; i++) { const x = i % 2 ? a : b; r += a.push(i) + ',' + b.push(i, i) + ',' + x.push(i) + ';'; } return r + a + '|' + b; } f()", "2,3,4;3,6,4;5,8,9;1,0,1,1,2|2,0,0,0,1,1,2,2,2");
    try expectRuns("function f(o) { let r = 0; for (let i = 0; i < 3; i++) r += o.push(i); return r; } f({ push(v) { return v * 2; } }) + ':' + f([])", "6:6");
    // An own property that shadows the method ends the cache's answer.
    try expectRuns("function f() { const a = []; let s = 0; for (let i = 0; i < 4; i++) { a.push(i); if (i === 1) a.push = function (v) { s += v; return 0; }; } return a.length + ':' + s; } f()", "2:5");
    try expectRuns("function f(o) { let s = 0; for (let i = 0; i < 3; i++) s += o.m(i); return s; } f({ m(v) { return v * 2; } })", "6");
}

test "exact integer remainder stays in native code and other operands use the VM" {
    if (!jit.available) return error.SkipZigTest;
    const fast = try jitCost(
        "function rem(a, b) { return a % b; } for (let i = -500; i < 500; i++) rem(i, -7); rem(-0, 3); rem(9007199254740991, 3)",
        .{helpers.binary},
    );
    try std.testing.expectEqual(2, fast.compiled);
    try std.testing.expectEqual(0, fast.calls[0]);
    const slow = try jitCost(
        "function rem(a, b) { return a % b; } rem(1.5, 1); rem(1, 0.5); rem(1, 0); rem(1, -0); rem(Infinity, 1); rem(1, Infinity); rem(NaN, 1); rem(1, NaN); rem(9007199254740992, 3); rem(3, 9007199254740992); rem('7', 3)",
        .{helpers.binary},
    );
    try std.testing.expectEqual(2, slow.compiled);
    // Three of the eleven need no division and so no helper: 1.5 % 1 is one subtraction, and
    // 1 % Infinity and 3 % 2^53 are their dividends.
    try std.testing.expectEqual(8, slow.calls[0]);
}

test "a global name is looked up once per function" {
    if (!jit.available) return error.SkipZigTest;
    const r = try jitCost(
        "function g() { return 1; } function f() { let s = 0; for (let i = 0; i < 1000; i++) s += g(); return s; } f()",
        .{ helpers.loadGlobal, helpers.call },
    );
    try std.testing.expectEqual(3, r.compiled);
    // `g` in f's loop misses once; `f` in the script hits the cache its declaration filled.
    // 1000 calls of g and one of f.
    try std.testing.expectEqual([2]usize{ 1, 1001 }, r.calls);
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

test "synchronous calls restore frames across native reentry and exception unwinding" {
    try expectRuns("function f(){return arguments.length;} [f(),f(1),f(1,2),f(1,2,3),f(1,2,3,4)].join()", "0,1,2,3,4");
    try expectRuns("function f(){throw arguments.length;} let s=''; try{f();}catch(e){s+=e;} try{f(1);}catch(e){s+=e;} try{f(1,2);}catch(e){s+=e;} try{f(1,2,3);}catch(e){s+=e;} try{f(1,2,3,4);}catch(e){s+=e;} s", "01234");
    try expectRuns("function f(n) { if (!n) return 1; return [n].map(function(x) { return f(x - 1); })[0] + n; } f(30)", "466");
    try expectRuns("let log = ''; function f(n) { try { if (!n) throw 'x'; return f(n - 1); } finally { log += n; } } try { f(5); } catch (e) { log += e; } log", "012345x");
    try expectRuns("function fail(n) { if (n) return fail(n - 1); throw 7; } function f() { let x = 3; try { fail(30); } catch (e) { x += e; } return x; } f() + f()", "20");
    try expectRuns("function f(n) { var x; if (n) { x = { n: n }; f(n - 1); return x.n; } return x; } f(3) + ',' + f(0)", "3,undefined");
}

fn collectDuringCall(_: u32, _: [*c]const Value, _: [*c]c.JSRTEnv) callconv(.c) Value {
    c.jsrt_gc_collect();
    return rt.undefined_value;
}

test "saved callers remain GC roots across collection and native reentry" {
    _ = try runOk("0");
    var roots = [_]Value{c.jsrt_closure_new(&collectDuringCall, 0, "collectDuringCall", null, false)};
    var frame: c.JSRTFrame = .{ .prev = c.jsrt_frame_top, .count = 1, .slots = &roots, .env = null };
    c.jsrt_frame_top = &frame;
    defer c.jsrt_frame_top = frame.prev;
    c.jsrt_set_prop(builtins.global(), "collectDuringCall", roots[0], null);
    try expectRuns("function f(n) { const x = {value: 'x' + n}; if (n) [n].map(function(k) { return f(k - 1); }); else collectDuringCall(); return x.value; } f(30)", "x30");
    try expectRuns("function f(){ let x={valueOf(){return 'old';}}; const a={get y(){x=null;collectDuringCall();return 'rhs';}}; x+=a.y; return x; } f()", "oldrhs");
    try expectRuns("function f(){ let x={valueOf(){collectDuringCall();return 'old';}}; x+='rhs'; return x; } f()", "oldrhs");
    try expectRuns("function f(x){return x+'rhs';} f({valueOf(){collectDuringCall();return 'old';}})", "oldrhs");
}

test "integer execution preserves overflow, negative zero and mixed numeric values" {
    try expectRuns("function f(){ let low=0-2147483647; --low; return JSON.stringify({zero:0, one:1, high:2147483647, low:low, mixed:[2,2.5,-0,Infinity]}); } f()", "{\"zero\":0,\"one\":1,\"high\":2147483647,\"low\":-2147483648,\"mixed\":[2,2.5,0,null]}");
    try expectRuns("function f(x) { return [x + 1, x - 1, ++x, --x].join(); } f(2147483647) + ';' + f(-2147483648)", "2147483648,2147483646,2147483648,2147483647;-2147483647,-2147483649,-2147483647,-2147483648");
    try expectRuns("function r(x,y) { return x % y; } [Object.is(r(-4,2), -0), Number.isNaN(r(1,0)), r(-2147483648,-1), r(7,2.5), r(7,Infinity), r('7',3)].join()", "true,true,0,2,7,1");
    try expectRuns("function f(x,y) { return [x + y,x - y,x < y,x <= y,x === y].join(); } f(1,1.0) + ';' + f(1,0.5)", "2,0,false,true,true;1.5,0.5,false,false,false");
}

test "call values without captured bindings" {
    try expectRuns("function f() { return this.x; } f.call({x: 7})", "7");
    try expectRuns("function f() { 'use strict'; return this; } f()", "undefined");
    try expectRuns("function f() { return this === globalThis; } f()", "true");
    try expectRuns("function C() { this.x = new.target === C; } new C().x", "true");
    try expectRuns("function C() { this.x = 9; return 1; } new C().x", "9");
    try expectRuns("function C() { return {x: 8}; } new C().x", "8");
    try expectRuns("class A { m() { return 3; } } class B extends A { m() { return super.m() + 1; } } new B().m()", "4");
    try expectRuns("class A { constructor() { this.x = 5; } } class B extends A { constructor() { super(); this.x++; } } new B().x", "6");
    try expectRuns("function f() { return () => this.x; } f.call({x: 6})()", "6");
}

test "discarded updates still coerce and throw once" {
    try expectRuns("function f() { let x = '2'; x++; ++x; x--; --x; return x; } f()", "2");
    try expectRuns("function f() { let calls=0; let x={valueOf() { calls++; return 4; }}; x++; return x + calls; } f()", "6");
    try expectRuns("function f() { const x=1; try { x++; } catch(e) { return e.name; } } f()", "TypeError");
    try expectRuns("function f() { try { x++; let x; } catch(e) { return e.name; } } f()", "ReferenceError");
    try expectRuns("function f() { let x={valueOf() { throw 8; }}; try { x++; } catch(e) { return e + ':' + typeof x; } } f()", "8:object");
    try expectRuns("function f() { let x='4'; let a=x++; let b=++x; return a + ':' + b + ':' + x; } f()", "4:6:6");
    try expectRuns("function f() { let x=0; for (;x<4;(x++)) {} return x; } f()", "4");
}

test "direct method caches preserve overrides and evaluation order" {
    try expectRuns("function f() { const a=[]; for(let i=0;i<4;i++) a.push(i); a.push=function(x) { return x+10; }; return a.push(3)+a.length; } f()", "17");
    try expectRuns("function f() { const a=[], b=[]; for(let i=0;i<6;i++) (i%2 ? a:b).push(i); return a.join()+':'+b.join(); } f()", "1,3,5:0,2,4");
    try expectRuns("function f() { const a=[]; a.push(0); a.push((a.push=function(){return 7;}, 2)); return a.join()+':'+a.push(3); } f()", "0,2:7");
    try expectRuns("function f() { const a=[]; a.push(1); Object.defineProperty(a,'push',{get(){ throw 9; }}); try { a.push(2); } catch(e) { return e; } } f()", "9");
    try expectRuns("function f() { let reads=0; const a={get m(){ reads++; return function(){return reads;}; }}; a.m(); return a.m(); } f()", "2");
}

test "cached string literals remain immutable and survive suspension" {
    try expectRuns("function f() { let s='ab'; for(let i=0;i<10000;i++) s+='ab'; return s.length+':'+('ab'); } f()", "20002:ab");
    try expectRuns("function* f() { for(let i=0;i<3;i++) yield 'cached'; } let s=''; for(const v of f()) s+=v; s", "cachedcachedcached");
}

test "discarded assignments preserve ordering and destructuring" {
    try expectRuns("function f() { let a=0,b=0; a=b=3; a+=b; [a,b]=[b,a]; return a+':'+b; } f()", "3:6");
    try expectRuns("function f() { let x=1; const o={get a(){x++;return 4;},set a(v){x+=v;}}; o.a+=3; return x; } f()", "9");
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
    const out = runScript("with ({}) {}", false);
    try std.testing.expect(out == .unsupported);
}

/// Runs `setup`, drains the microtask queue, then expects `check` to evaluate to `want`.
fn expectSettles(setup: []const u8, check: []const u8, want: []const u8) !void {
    _ = try runOk(setup);
    rt.c.jsrt_run_microtasks();
    try expectRuns(check, want);
}

test "generators" {
    try expectRuns("function* g(a) { const b = yield a; yield a + b; } const it = g(1); [it.next().value, it.next(10).value, it.next().done].join()", "1,11,true");
    try expectRuns("function* g() { yield 1; yield 2; return 3; } [...g()].join()", "1,2");
    try expectRuns("function* g() { try { yield 1; } finally { log += 'f'; } } var log = ''; const it = g(); it.next(); it.return(5).value + log", "5f");
    try expectRuns("function* g() { try { yield 1; } catch (e) { yield 'c' + e; } } const it = g(); it.next(); it.throw('x').value", "cx");
    try expectRuns("function* inner() { const x = yield 1; return x * 2; } function* outer() { const r = yield* inner(); yield r; } const it = outer(); it.next(); it.next(4).value", "8");
    try expectRuns("function* g(a = log += 'p') { log += 'b'; } var log = ''; g(); log", "p");
    try expectRuns("let m; try { new (function* () {})(); } catch (e) { m = e instanceof TypeError; } m", "true");
    try expectRuns("const o = { *m() { yield this.k; }, k: 7 }; o.m().next().value", "7");
}

test "async functions" {
    try expectSettles("var log = ''; async function f(x) { log += 'a'; const v = await x; log += v; return v + 1; } f(Promise.resolve(2)).then((r) => { log += r; }); log += 's';", "log", "as23");
    try expectSettles("var caught; (async () => { try { await Promise.reject(new TypeError('t')); } catch (e) { caught = e instanceof TypeError; } })();", "caught", "true");
    try expectSettles("var why; (async function () { throw 'boom'; })().catch((e) => { why = e; });", "why", "boom");
}

test "async generators and for await" {
    try expectSettles(
        \\var out = '';
        \\async function* g() { yield 1; const x = yield await Promise.resolve(2); yield x; }
        \\(async () => { for await (const v of g()) out += v; for await (const v of [Promise.resolve('a'), 'b']) out += v; })();
    , "out", "12undefinedab");
    try expectSettles(
        \\var log = '';
        \\async function* g() { try { yield 1; yield 2; } finally { log += 'f'; } }
        \\(async () => { for await (const v of g()) { log += v; break; } })();
    , "log", "1f");
    try expectSettles(
        \\var r = '';
        \\async function* g() { yield 1; }
        \\const it = g(); it.next().then((a) => { r += a.value + ',' + a.done; }); it.next().then((b) => { r += ';' + b.done; });
    , "r", "1,false;true");
    try expectSettles(
        \\var s = '';
        \\async function* inner() { yield 'i'; return 'r'; }
        \\async function* outer() { const r = yield* inner(); yield r; yield* [Promise.resolve('p')]; }
        \\(async () => { for await (const v of outer()) s += v; })();
    , "s", "irp");
}

test "local immediate operators preserve coercion, TDZ and exceptional completion" {
    try expectRuns("function f(x) { return [x + 2, x - 2, x < 2, x <= 2].join(); } f('2') + ';' + f(null)", "22,0,false,true;2,-2,true,true");
    try expectRuns("function f() { try { return x - 1; } catch (e) { return e instanceof ReferenceError; } let x; } f()", "true");
    try expectRuns("var calls = 0; function f(x) { return x + 1; } f({ valueOf() { calls++; return 'a'; } }) + calls", "a11");
    try expectRuns("function f(x) { try { return x < 1; } catch (e) { return e; } } f({ valueOf() { throw 'coercion'; } })", "coercion");
    try expectRuns("function f(x) { return x + 0; } Object.is(f(-0), 0) + ',' + Number.isNaN(f(NaN))", "true,true");
}

test "fused local reads preserve operand order and argument initialization" {
    // The JIT's dead-store pass must see both fused operands as reads of initialized locals.
    try expectRuns("function f() { let a = 2; let b = 3; return a + b; } f()", "5");
    try expectRuns("function f() { let a = 2; return a + 1; } f()", "3");
    try expectRuns("function f(a, b) { return [a + b, a - b, a < b, a <= b].join(); } f('2', 3)", "23,-1,true,true");
    try expectRuns("function f() { let x; try { x = a + b; } catch (e) { return e instanceof ReferenceError; } let a, b; } f()", "true");
    try expectRuns("function f(a, b = 3, c) { return [a, b, c].join(); } f(1) + ';' + f(1, 2, 4)", "1,3,;1,2,4");
    try expectRuns("function f(a, a) { return a; } f(1, 2) + ',' + f(1)", "2,undefined");
    try expectRuns("function f(a, b) { a += b; return a; } f('x', 2)", "x2");
}

test "invalid super calls in eval throw instead of writing immutable call values" {
    try expectRuns("let result; try { eval('super()'); } catch (e) { result = e instanceof SyntaxError; } result", "true");
    try expectRuns("let result; try { (0, eval)('super()'); } catch (e) { result = e instanceof SyntaxError; } result", "true");
}

test "combined reads and returns preserve lookup and coercion order" {
    try expectRuns("function f(a,i) { return a[i]; } f({x: 7}, 'x') + f([3], 0)", "10");
    try expectRuns("function f(a,i) { return a[i]; } let log=''; const k={toString(){ log+='k'; return 'x'; }}; const a={get x(){log+='g'; return 9; }}; f(a,k) + log", "9kg");
    try expectRuns("function f() { try { return a[i]; } catch(e) { return e instanceof ReferenceError; } let a, i; } f()", "true");
    try expectRuns("function f() { return 1; } function g() { f = function(){return 2;}; return 0; } f(g()) + f()", "3");
    try expectRuns("function run() { let f = function(){return 1;}; return f(f = function(){return 2;}) + f(); } run()", "3");
    try expectRuns("function f() { return x; let x; } let r; try { f(); } catch(e) {r=e instanceof ReferenceError;} r", "true");
    try expectRuns("function C() { const x=7; this.x=x; return x; } new C().x", "7");
    try expectRuns("function make(v) { let x=v; return function() { return ++x; }; } make('2')() + make(2147483647)()", "2147483651");
    try expectRuns("function make() { let x={valueOf(){throw 7;}}; return function() {try {return ++x;} catch(e){return e;}}; } make()()", "7");
}

test "compound stores preserve captured operands, coercion and exceptions" {
    try expectRuns("function f() { let x=1; x += (x=10); return x; } f()", "11");
    try expectRuns("function f() { let x={valueOf(){return 'a';}}; x += 'b'; return x; } f()", "ab");
    try expectRuns("function f() { let x=1; try { x += {valueOf(){throw 'e';}}; } catch(e) { return x+e; } } f()", "1e");
    try expectRuns("function f() { let log=''; try { x += (log+='r'); } catch(e) { return (e instanceof ReferenceError)+log; } let x; } f()", "true");
    try expectRuns("let log=''; const a={get x(){log+='g'; return {valueOf(){log+='v'; return 2;}};}, set x(v){log+='s'+v;}}; function rhs(){log+='r'; return 3;} a.x += rhs(); log", "grvs5");
    try expectRuns("let log=''; const a={get x(){throw 'g';},set x(v){log+='s';}}; try {a.x += (log+='r');} catch(e){log+=e;} log", "g");
    try expectRuns("let log=''; const a={get x(){return 2;},set x(v){throw v;}}; try {a.x += 3;} catch(e){log+=e;} log", "5");
    try expectRuns("const a={x:'a'}; a.x += 'b'; a.x", "ab");
}

test "combined compound reads keep the old LHS through RHS effects" {
    try expectRuns("function C(){this.x=7;return 'a'+1;} new C().x", "7");
    try expectRuns("function f(x){return 'a'+x;} let out; try{f({valueOf(){throw 7;}});}catch(e){out=e;} out", "7");
    try expectRuns("function f(a,b){return a()+b();} let log=''; f(()=>{log+='a';return 1;},()=>{log+='b';return 2;})+log", "3ab");
    try expectRuns("function f(){let log=''; let a={valueOf(){log+='a';return 1;}}; const b={get x(){log+='g';return {valueOf(){log+='b';return 2;}};}}; return (a<b.x)+log;} f()", "truegab");
    try expectRuns("function f(a,b){return [a<b.x,a<=b.x].join();} f('10',{x:'2'})", "true,true");
    try expectRuns("function f(a){try{return a<b.x;}catch(e){return e instanceof ReferenceError;} let b;} f(1)", "true");
    try expectRuns("function f(){ let x=1; const a={get y(){x=10;return 2;}}; x+=a.y; return x; } f()", "3");
    try expectRuns("function f(){ let x=1; const a={y:2}; const k={toString(){x=10;return 'y';}}; x+=a[k]; return x; } f()", "3");
    try expectRuns("function f(){ let x={valueOf(){return 'a';}}; const a={y:2}; x+=a.y; return x; } f()", "a2");
    try expectRuns("function f(){ let x=1; let a=null; try{x+=a.x;}catch(e){return (e instanceof TypeError)+','+x;} } f()", "true,1");
    try expectRuns("function f(){ let x=1; const a={get y(){throw 'g';}}; try{x+=a.y;}catch(e){return x+e;} } f()", "1g");
    try expectRuns("function f(){ let x='a'; x+='b'; return x; } f()", "ab");
    try expectRuns("function f(){ let x=1; try{x+=a.y;}catch(e){return e instanceof ReferenceError;} let a; } f()", "true");
    try expectRuns("function f(){ let x=1; const a={}; try{x+=a[k];}catch(e){return e instanceof ReferenceError;} let k; } f()", "true");
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
