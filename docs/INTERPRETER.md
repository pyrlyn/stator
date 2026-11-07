# The interpreter (Phase 14)

`js` mode's second fallback: the code compiled code cannot run (`eval`, `new Function`, and the
`not-yet` constructs §6 assigns to it) runs in an interpreter linked into the binary. This is the
design T14.0 settled (plan.md §11f, plan-notes 396). The cards that build it are
[`plan/T14.1`](../plan/T14.1/task.md) to [`plan/T14.4`](../plan/T14.4/task.md).

Fallbacks are tried in this order: compiled static code, compiled dynamic code (NaN-boxed values,
shapes, ICs), then the interpreter. `ts` mode never reaches it: `eval` stays `STA1101` and
`new Function` stays `STA1103`, permanently.

## 0. The spike

The design rests on a measured spike, run on 2026-11-06 on an Apple M3 Max (arm64), macOS, clang
21.1.8, Zig 0.17.0, Node 26.7.0, from `origin/main` at `5decef0`.

- **Evaluator spike.** A 720-line strict-TypeScript evaluator for a small subset (numbers, strings,
  `let`/`var`/`const`, `if`, `while`, functions, closures, calls, binary operators) with two
  execution models over one parser: a tree walker with a `Map` per scope, and a bytecode stack VM
  whose names are resolved to `(depth, slot)` at compile time. Compiled by Stator in `ts` mode and
  imported from a `js`-mode program (`main.js`), it printed what Node prints for
  `1 + 2 * 3 - 4 / 8`, `'a' + 1 + 2`, a function body with a `while` loop, and a `SyntaxError`
  caught by the caller.
- **Parser spike.** The stator-ts parser (`packages/transpiler/src/parser.zig`, plan/T41) driven by
  a 25-line Zig program that parses an in-memory source.

The spike's sources are not committed; this section and plan-notes 396 hold its numbers.

| Measurement | Value |
| --- | --- |
| `fib(25)` through the tree walker, Stator-compiled | 1.20–1.26 s |
| `fib(25)` through the bytecode VM, Stator-compiled | 0.41–0.43 s |
| The same evaluator under Node 26.7.0 (JIT) | tree 37–45 ms, VM 30–31 ms |
| Parse 657,780 bytes (20,000 statements), spike parser, Stator-compiled | 316–318 ms |
| Same, spike parser under Node | 25–31 ms |
| Same, stator-ts parser, Zig `ReleaseFast` | 7–8 ms |
| Same, stator-ts parser, Zig `ReleaseSmall` | 11–12 ms |
| Binary, `js`-mode `console.log` only (stripped) | 256,240 B |
| …plus the spike's parser and tree walker (stripped) | 308,256 B (+52,016) |
| …plus the spike's parser and bytecode VM (stripped) | 325,168 B (+68,928) |
| stator-ts parser alone over an empty Zig program, `ReleaseSmall` (stripped) | +66,112 B |
| stator-ts parser alone over an empty Zig program, `ReleaseFast` (stripped) | +132,240 B |

The spike also found two compiler bugs, which plan-notes 396 lists: `.length` on a dynamically read
receiver (fixed, pyrlyn/stator#248) and the method-call receiver guess (fixed for direct calls by
plan-notes 395; the spike worked around it).

## 1. The parser: stator-ts's, in Zig

Options measured (the creator chose (d), 2026-11-06):

- **(a) The `typescript` package's parser, compiled by Stator in `js` mode.** It does not build:
  `statorc explain lib/typescript.js --mode=js --node` stops with `STA0013` (the checker runs out
  of stack) after 2.8 s. It waits on T11.4 and tree-shaking (Phase 12), and the compiler is moving
  off `typescript` anyway (plan/T41).
- **(b) A maintained ECMAScript parser in TypeScript, vendored.** The only maintained candidate is
  meriyah 7.4.1 (ISC, 15,754 lines, `github.com/meriyah/meriyah` at `a1ccee4`, 2026-10-26).
  Under the locked `tsconfig.json` and the `ts`-mode gate it raises 383 diagnostics: 21 `enum`
  declarations (`erasableSyntaxOnly`), 30 `any`, 131 strict-mode type errors, 110 explicit type
  arguments on calls, and more. Vendoring it means maintaining a fork. esprima (4.0.1, last change
  2023-04-30) is unmaintained; acorn is JavaScript.
- **(c) A parser written here, in strict TypeScript.** It needs §0.3 edited, and the spike's parser
  is 30–40 times slower than (d) after Stator compiles it.
- **(d) stator-ts's parser, in Zig.** The project's own parser (plan/T41), so §0.3 holds: no new
  parser is written, and a gap is fixed in stator-ts with a regression test (AGENTS.md golden
  rule 5). 7–12 ms for 640 KB, and 66 KB in `ReleaseSmall`.

The interpreter imports `parser.zig` as a Zig module of its own, because stator-ts's `lib.zig`
does not export it (`packages/interpreter/src/parse.zig`, T14.1). `parse` reads `eval` code with
the Script goal (ECMA-262 §19.2.1), or a module. `parseFunction` builds CreateDynamicFunction's
source text (§20.2.1.1.1), `<prefix> anonymous(<params>\n) {\n<body>\n}`, and parses it once. It
keeps the tree only when it is that one function with its parameters and its body where the text
put them: a piece that closes its own bracket early (`a) {}; f(b`) moves one of them, which is
what parsing the two pieces separately catches.

Early errors become a `SyntaxError` thrown at run time through `jsrt_throw_error`
(`jsrt_interp_parse_script` in `src/capi.zig`). The check is the error's TYPE, which is exactly
what Test262 negative tests ask. The message is stator-ts's diagnostic text, which is tsc's
wording. Module syntax under the Script goal is the exception and uses Node's text. Golden
fixtures print `e.name`, never the message, because message parity with Node is not settled.

**Parse rate** (plan-notes 400). `pnpm run test262:interp-parse` runs Test262's `test/language/`
through `parse` in every mode a test's flags ask for. At the pin it passes 19,162 of 23,726 tests
(80.76%), at about 190 MiB/s. The counts are ratcheted per directory in
`packages/interpreter/test262-parse.json`. The rest is stator-ts's to close:

- 3,444 tests parse but must not. These are early errors stator-ts reports in its binder or
  checker, or not at all.
- 1,120 tests are rejected though valid. These are syntax it does not read.

## 2. Execution model: bytecode, in Zig

The evaluator is Zig in the runtime (the creator chose this on 2026-11-06, replacing plan-notes
300's strict-TypeScript package; AGENTS.md golden rule 9 gives runtime code to Zig). It compiles
the stator-ts AST to bytecode and runs that.

- **Why bytecode.** On the spike the bytecode VM ran `fib(25)` 2.9 times faster than the tree
  walker. Most of the gap is that the compiler resolves every name to a slot once, which a tree
  walker can only do by annotating the tree; resumable frames (§5) are also simpler when the state
  is a program counter and a register file rather than a native call stack. QuickJS made the same
  choice.
- **Shape.** One compile pass per function: scope analysis resolves each binding to a register, a
  closure cell, or (only under a direct `eval` or `with`, §3) a name looked up at run time.
  Instructions are a flat `u8` stream with inline operands; constants and nested function
  templates sit in per-function tables. The AST is dropped after compilation.
- **Values.** Registers hold `jsrt_value`. The interpreter holds no value model, object model or
  GC of its own: it calls the C ABI compiled dynamic code calls (`jsrt_get_prop` with a per-site
  inline cache, `jsrt_call_at`, `jsrt_op_add`, …). An instruction that touches a property owns an
  IC slot in its function's IC table, the same `JSRTIC` compiled code uses.

## 3. Direct `eval`, indirect `eval`, and scopes

- **Which calls are direct.** A call `eval(…)` whose callee is the identifier `eval` with no
  declaration of that name in scope (ECMA-262 §13.3.6.1). Everything else that reaches the global
  `eval` function is indirect: `(0, eval)(s)`, `globalThis.eval(s)`, `const e = eval; e(s)`.
- **What a direct `eval` sees.** Every binding visible at the call, in every enclosing function.
  The frontend marks each such binding "eval-visible", and lowering stores it in a closure cell,
  exactly as a captured binding is stored, whatever its type: an `eval` can write any value, so a
  typed binding visible to it becomes a dynamic one. The call site passes a scope descriptor: a
  static table of `(name, cell)` pairs per scope, chained outward to the module scope. Functions
  with no direct `eval` keep today's layout, so their code does not change.
- **What an indirect `eval` sees.** The global scope only: `globalThis` properties and the
  global declarative bindings (ECMA-262 §19.2.1.1). Module-level bindings of a module are not
  global and stay invisible, as in Node.
- **`var` in eval code.** ES modules are strict, and so is every direct `eval` inside one: its
  `var` and function declarations live in a fresh environment and vanish when it returns. That is
  every `js`-mode file today. Sloppy code exists only in CommonJS that the bundler wraps under
  `--node`; there a direct `eval`'s `var` is added to the caller's variable environment, which the
  scope descriptor models as one dynamic object per function, consulted after the static cells.
  T14.3 lands the strict case; the sloppy case lands with it only if a bundled-CommonJS fixture
  needs it, and otherwise stays `STA1206` until one does.
- **`new Function(p…, body)`** parses `p…` and `body` as one function and creates it in the
  global scope, like an indirect `eval`.

## 4. The boundary with compiled code

- **Calls, compiled → interpreted.** An interpreted function is an ordinary `JSRTClosure` whose
  `fn` is one trampoline (`jsrt_interp_call`) and whose `env` points at the function's template
  and captured cells. `jsrt_call`, `jsrt_construct`, `typeof`, `.length` (from `arity`) and
  `.name` work on it unchanged. `has_receiver` is set for a function that reads `this`.
- **Calls, interpreted → compiled.** The VM calls `jsrt_call_at`, `jsrt_call_with_this` and
  `jsrt_construct`, so a compiled callee cannot tell who called it.
- **Exceptions.** The runtime has no `setjmp`: a throw sets the pending exception and returns, and
  generated C checks `jsrt_pending()` after every call and jumps to its landing pad. The VM does
  the same after every instruction that can run user code, and on a pending exception it unwinds
  to the innermost handler in its own handler table or returns to its caller with the exception
  still pending. Compiled frames pop through their own pads (`JSRT_FRAME` discipline unchanged),
  and no frame of either kind is skipped.
- **GC roots.** Interpreter frames (register files, the operand stack, the scope chain) are
  allocated from the GC heap through the Zig memory core (`jsrt_mem`), so the collector traces
  them; a frame pointer on the native stack is scanned like any other. Bytecode and IC tables are
  GC-allocated and reachable from the function template.
- **`this`, `new.target`, `arguments`.** `this` is the receiver slot of the call convention
  (`has_receiver`), `undefined` in strict code without one. `new.target` is passed by the construct
  path (`jsrt_construct` → the trampoline's construct entry) and is `undefined` on a plain call.
  `arguments` is materialized only by a function that names it: a strict-mode unmapped arguments
  object built from `argv`; the mapped (sloppy) form follows §3's sloppy case.

## 5. Async functions and generators

A bytecode frame is a heap object, so suspending is saving the program counter, nothing else.
The interpreter uses the runtime's existing machinery, with no second event loop:

- **`async` / `await`**: an interpreted async function starts with `jsrt_async_start`, whose
  `JSRTResume` is one VM entry that re-enters the saved frame; `await` is `jsrt_await`, and
  completion is `jsrt_async_return` / `jsrt_async_throw`. Reactions run on the runtime's microtask
  queue (Task 4.6), interleaved with compiled code's.
- **Generators**: the generator object is the runtime's (Phase 5 step 8), with the VM's resume
  entry as its resume point; `return(v)` and `throw(e)` use the same injection protocol, routed
  through the frame's `finally` handlers.
- **`for await` and async generators** compose the two.

## 6. Which `not-yet` codes the interpreter takes

| Code | Construct | Owner after Phase 14 |
| --- | --- | --- |
| `STA1206` | `eval`, `new Function` in `js` mode | the interpreter, first (T14.3) |
| `STA1201` | generator methods, async generators, `for await` | the interpreter (T14.4), by interpreting the enclosing function |
| `STA1202` | `arguments` in `js` mode | the interpreter (T14.4), same route |
| `STA1214` | subset-boundary constructs, `js` mode only | the interpreter (T14.4), construct by construct; each one flips its decision tests |
| `STA1203` | `Proxy` | stays: it needs an exotic-object hook in the runtime's object model, not an evaluator |
| `STA1204` | prototype mutation | stays: shape and IC invalidation in the runtime |
| `STA1205` | `delete` on a fixed-shape object | stays: dictionary mode in the runtime |
| `STA1207` | `import()` with a computed specifier | stays: runtime module resolution |
| `STA1210`, `STA1211`, `STA1213`, `STA1215`, `STA1216`, `STA1219`, `STA1220` | builtins, BigInt, ICU, FFI library output | stay: library or toolchain work, not evaluation |

"By interpreting the enclosing function" is the general fallback: in `js` mode, a function whose
body holds a construct the interpreter takes is lowered to an `Interpret` node carrying the
function's source span, and its captured bindings cross as §3's scope descriptor. `ts` mode never
does this. No diagnostic code is allocated by T14.0; T14.3 allocates one in `docs/DIAGNOSTICS.md`
if the sloppy `var` case of §3 stays out.

## 7. QuickJS-NG (Phase 8) after this

Phase 8's vendored QuickJS-NG stays as it is, behind its own gate, and no `--interpreter` flag is
added before there is something to compare. The question is answered by numbers, once T14.2 runs
the §8 Test262 slice: QuickJS-NG is retired if the interpreter passes at least 95% of what
QuickJS-NG passes on the same slice and the binary delta of a program with one `eval` is smaller;
otherwise it stays behind `--interpreter=stator|quickjs`, defaulting to `stator`. Either answer
goes to plan-notes with both numbers.

## 8. Oracle

- **Test262** (Task 6.1, `packages/tests/test262/pin.json`): a second runner mode runs each test
  through the interpreter. Before T14.3 the host is a Zig test driver that calls the interpreter's
  entry point directly; after T14.3 it is a compiled `js` program that hands the test source to an
  indirect `eval`, so every test executes in the interpreter and the harness's `$262` helpers are
  compiled code. The pass rate is a column of its own in the Task 6.3 dashboard.
- **Differential fuzzing** (Task 6.2): the fuzzer's programs also run as `eval` strings, against
  the pinned Node.
- **Golden fixtures** (`packages/tests/golden/js/eval_*`): byte-for-byte against Node.

## 9. Where the code lives

| Package | Holds | Must not |
| --- | --- | --- |
| `packages/interpreter` (Zig) | the parser front (`src/parse.zig`, T14.1); the bytecode compiler and the VM; the entry points the runtime calls (`src/capi.zig`: `eval`, the `Function` constructor, the trampoline); the Test262 parse driver (`test262/parse.zig`). It is built into `libjsrt_interp.a` and imports stator-ts's `parser.zig` | hold its own value model, object model or GC |
| `packages/transpiler` (stator-ts) | the parser | know the interpreter exists |
| `packages/compiler` (and plan/T41's Zig port) | the `Interpret` HIR node, the eval-visible cells and scope descriptors of §3, and linking `libjsrt_interp.a` only when an `Interpret` node exists | interpret anything at compile time |
| `packages/runtime` | the C ABI the VM calls | grow a second dispatch path |

A binary without an `Interpret` node does not link `libjsrt_interp.a`, so its size is
byte-identical to before; every `ts`-mode binary is in that set.
