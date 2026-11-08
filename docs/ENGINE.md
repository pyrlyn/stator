# The engine

`packages/engine` is Stator's JavaScript engine in Zig (plan/T67). It runs a script directly,
without the ahead-of-time pipeline, in one of two modes over one bytecode:

- **`interp`**: the Phase-14 bytecode interpreter (`docs/INTERPRETER.md`), small and light. It is
  the same code the compiled binaries link as `libjsrt_interp.a` for `eval` and `new Function`.
- **`jit`**: a baseline JIT (§3) that turns a function's bytecode into native code on its first
  call and runs every function it does not take in the interpreter.

Values, objects, shapes, inline caches and the collector are the runtime's (`libjsrt.a`, with
pyrlyn/gc since T66). The engine adds no second heap and no second value model.

## 1. Layout

| Path | Holds |
| --- | --- |
| `src/engine.zig` | `run`: a source in one of the engine's languages (§2), run in one mode, with the outcome |
| `src/cli.zig` | `stator-engine` (§5) |
| `src/jit/analyze.zig` | Which templates the JIT takes, and the operand-stack depth at every instruction |
| `src/jit/lower.zig` | Bytecode to pyrlyn/jit IR, with the inline fast paths |
| `src/jit/helpers.zig` | What native code calls for everything else: the VM's own operations |
| `src/jit/jit.zig` | Compile on first call, cache on the template, enter native code |
| everything else | the interpreter, as `packages/engine/README.md` lists it |

## 2. Input languages

| Language | Extensions | How it runs |
| --- | --- | --- |
| `js` | `.js` `.mjs` `.cjs` | parsed by stator-ts's parser, compiled to bytecode |
| `ts` | `.ts` `.mts` `.cts` | stator-ts erases the types (`packages/transpiler/src/erase.zig`: parse, bind, emit JavaScript), then as `js`. Types are not checked: a script with type errors runs, as under Node's type stripping |
| `wasm` | `.wasm` | named and rejected until plan/T67.3 adds a WebAssembly runtime |

Compiling JavaScript or TypeScript *to* WebAssembly (plan/T67.2) and to Zig source (plan/T67.4)
are `build` targets the CLI names and rejects until those cards land.

## 3. The baseline JIT

The JIT takes a function on its first call in `jit` mode, compiles it once and keeps the code on
its template (`Template.jit`); templates are immortal, so the code is never released. A template
it rejects stays rejected and runs in the interpreter. `STATOR_JIT_TRACE=1` prints what happened
to every template.

**What it takes.** `analyze.zig` walks the reachable bytecode, computes the operand-stack depth
at every instruction and rejects the template when two paths reach an instruction at different
depths, an opcode is outside the supported set, or the function has exception handlers, is a
generator or is async. Those stay in the interpreter, whose suspension and unwinding they need.

**Where values live.** The generated code keeps the operand stack where the interpreter keeps it:
in the frame window (`callee`, `this`, `new.target`, the locals, then the operands) that the VM
publishes to the collector as a `JSRTFrame`. Registers hold only what one instruction is working
on, so every value the collector can see is rooted precisely, and a helper that allocates or
collects needs no stack maps.

**Fast paths.** Inline, without a call:

- `+ - * /` on two doubles in f64. On x86-64 the result's NaN is collapsed into the canonical
  NaN, because x86-64's default NaN has `undefined`'s bit pattern; AArch64's default NaN is the
  canonical one already, so there the check is not emitted;
- `< > <= >= == === != !==` on two doubles through `fcmp`, written as `false + cmp`;
- `++`, `--`, unary `+` and unary `-` on a double (`-x` is `x * -1`, so `-0` and `+0` swap);
- `!` on a boolean, and the conditional jumps on `true` and `false`;
- locals, arguments, constants and the TDZ check of a checked local;
- `o.k` and `o.k = v` on a dynamic object whose shape the site's inline cache holds: a shape
  compare and a slot load or store (with the write barrier on the slots buffer), falling to the
  helper when the object is frozen, the slot holds an accessor or the shape differs. The key
  `constructor` always takes the helper;
- a global read through an inline cache of its own per site, on the global object's shape;
- sloppy `this` (nullish becomes the global object) and a constructor's return on a plain call;
- a pure push followed by a store to a local nothing reads (the prologue's `this`, `new.target`,
  `home` and `callee` when the body does not use them) is not emitted.

Everything else (mixed operands, strings, a cache miss, calls, environments, construction,
`throw`) calls a helper in `helpers.zig` that runs the VM's own function for the
operation. A helper answers 1 when it left an exception pending; the code then leaves through its
exit block, and the interpreter frame that called it unwinds as for any other throw.

**Backends.** pyrlyn/jit (pinned by commit in `build.zig.zon`) allocates registers and emits
AArch64 or x86-64 (System V). Only the AArch64 path has run so far: the x86-64 one compiles
but is unverified until a Linux x86-64 run. A Windows or other host has no backend; `jit` mode prints that and
interprets.

**What it is not yet.** A call from native code goes back through `vm.call` and the interpreter's
frame setup, every object literal allocates its slots and walks a shape transition per property,
and every operand goes through the frame window in memory. Calls, allocation and tight numeric
loops are where V8 is far ahead (§4); direct calls between compiled templates, a cached
transition per literal and the optimizing tier (plan/T67.1: type feedback, values in registers,
deoptimization) are the next steps.

## 4. Tests and benchmark

| Command | What it checks |
| --- | --- |
| `pnpm run interp:test` | The engine's Zig tests; every interpreter test runs in both modes, and the JIT tests assert the templates were compiled. In test builds every helper the JIT calls is counted (`helpers.counted`), and `jitCost` tests pin how often each runs: a numeric loop calls none, a cached property read misses once per site, a global read once per site |
| `pnpm run engine:test` | `packages/tests/engine/run.ts`: every script in `packages/tests/engine/scripts/` under the pinned Node and `stator-engine run` in both modes, stdout and exit status byte-for-byte; an uncaught error's first line; the CLI's usage errors and not-yet targets |
| `pnpm run engine:bench` | `packages/tests/engine/bench.ts`: the bench programs (`packages/tests/engine/scripts/` and the JavaScript ones in `packages/tests/engine/bench/`) under Node (V8) and `jit` mode, each output checked against Node's, best of N wall time and peak RSS; results in `packages/tests/engine/results/` (ignored). V8 is the only reference |
| `pnpm run engine:bench:zig` | `src/bench.zig`: the `packages/tests/engine/bench/` programs run by the engine inside one process, best of N, with no process or runtime start-up; prints the milliseconds and the templates compiled. `--mode=interp` measures the interpreter |

A measurement, not a claim: 2026-11-08, Apple M3 Max, macOS 27.0, Node v26.7.0, Zig 0.17.1,
`stator-engine` ReleaseFast, best of 5, wall milliseconds from spawn to exit (startup included).

| program | Node (V8) | jit | jit / V8 |
|---|---:|---:|---:|
| fib.ts | 88 | 552 | 6.29 |
| nbody.ts | 66 | 27 | 0.40 |
| string-churn.ts | 54 | 15 | 0.28 |
| json-roundtrip.ts | 52 | 6.5 | 0.13 |
| hello.ts | 48 | 5.9 | 0.12 |
| objects-churn.ts | 74 | 886 | 11.95 |
| objects-retained.ts | 107 | 923 | 8.65 |
| alloc.js | 41 | 520 | 12.70 |
| arrays.js | 51 | 337 | 6.64 |
| closures.js | 39 | 171 | 4.39 |
| fib.js | 46 | 209 | 4.52 |
| loop.js | 56 | 321 | 5.72 |
| methods.js | 36 | 292 | 8.21 |
| props.js | 42 | 419 | 9.92 |
| strings.js | 60 | 207 | 3.47 |

The engine starts in under 10 ms against Node's 50, so short scripts favor it. On hot code V8's
optimizing tiers are still 3.5–13 times faster than this baseline JIT. The inline caches and
prologue trimming above took `fib.ts` from 11.2 to 6.3 times V8's time and `objects-churn` from
15.3 to 12; a profile of `loop.js` now spends all its time inside generated code, so the rest of
that gap is the operand stack in memory and the tag checks, which the optimizing tier removes.

## 5. The CLI

```text
stator-engine run [--mode=interp|jit] [--lang=js|ts|wasm] <file>
stator-engine build --target=wasm|zig <file>
```

`--mode` defaults to `interp`; `--lang` defaults to the file's extension (§2). Exit status: 0 when
the script ran to the end, 1 for an uncaught exception (`Uncaught Name: message` on stderr), a
syntax error, a construct the engine does not run yet or a file it cannot read, 2 for a usage
error. `build` exits 1 naming the card that delivers its target.

```bash
zig build cli -Doptimize=ReleaseFast --build-file packages/engine/build.zig   # zig-out/bin/stator-engine
zig build run --build-file packages/engine/build.zig -- run --mode=jit file.ts
```
