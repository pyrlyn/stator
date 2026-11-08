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

- `+ - * /` on two doubles in f64, the result's NaN collapsed into the canonical NaN, because
  x86-64's default NaN has `undefined`'s bit pattern;
- `< > <= >= == === != !==` on two doubles through `fcmp`, written as `false + cmp`;
- `++`, `--` and unary `-` on a double (`-x` is `x * -1`, so `-0` and `+0` swap);
- `!` on a boolean, and the conditional jumps on `true` and `false`;
- locals, arguments, constants and the TDZ check of a checked local.

Everything else (mixed operands, strings, property access, calls, environments, globals,
construction, `throw`) calls a helper in `helpers.zig` that runs the VM's own function for the
operation. A helper answers 1 when it left an exception pending; the code then leaves through its
exit block, and the interpreter frame that called it unwinds as for any other throw.

**Backends.** pyrlyn/jit (pinned by commit in `build.zig.zon`) allocates registers and emits
AArch64 or x86-64 (System V). Only the AArch64 path has run so far: the x86-64 one compiles
but is unverified until a Linux x86-64 run. A Windows or other host has no backend; `jit` mode prints that and
interprets.

**What it is not yet.** A call from native code goes back through `vm.call` and the interpreter's
frame setup, and property access goes through the runtime's inline caches by helper. Calls and
property loads in hot loops are where V8 is far ahead (§4); direct calls between compiled
templates, inline IC checks and type feedback are the next steps.

## 4. Tests and benchmark

| Command | What it checks |
| --- | --- |
| `pnpm run interp:test` | The engine's Zig tests; every interpreter test runs in both modes, and the JIT tests assert the templates were compiled |
| `pnpm run engine:test` | `packages/tests/engine/run.ts`: every script in `packages/tests/engine/scripts/` under the pinned Node and `stator-engine run` in both modes, stdout and exit status byte-for-byte; an uncaught error's first line; the CLI's usage errors and not-yet targets |
| `pnpm run engine:bench` | `packages/tests/engine/bench.ts`: the bench programs under Node (V8) and both modes, each output checked against Node's, best of N wall time and peak RSS; results in `packages/tests/engine/results/` (ignored) |

A measurement, not a claim: 2026-11-08, Apple M3 Max, macOS 27.0, Node v26.7.0, Zig 0.17.1,
`stator-engine` ReleaseFast, best of 5, wall milliseconds from spawn to exit (startup included).

| program | Node (V8) | interp | jit | jit / V8 |
|---|---:|---:|---:|---:|
| fib(34) | 89 | 2439 | 996 | 11.2 |
| nbody | 56 | 99 | 32 | 0.58 |
| string-churn | 56 | 15 | 14 | 0.26 |
| json-roundtrip | 58 | 8.6 | 8.2 | 0.14 |
| hello | 56 | 7.5 | 7.5 | 0.13 |
| objects-churn | 77 | 2783 | 1187 | 15.3 |
| objects-retained | 105 | 1012 | 1003 | 9.6 |

The engine starts in under 10 ms against Node's 55, so short scripts favor it; on hot loops of
calls and property access V8's optimizing tiers are 10–15 times faster than this baseline JIT.
The JIT is 2.4 times faster than the interpreter on `fib` and 3 times on `nbody`.

### 4.1. Warmed V8 comparison (T69)

```sh
pnpm run runtime
node packages/tests/engine/steady.ts --rounds=3
```

This is separate from `engine:bench`, which includes process startup. It builds the
benchmark-only `stator-steady` host in ReleaseFast (`zig build steady`), reusing the engine and
runtime. `STATOR_STEADY` may name a prebuilt host. The host adds a monotonic `__benchNow`
clock only to the benchmark process; the production CLI and its globals are unchanged.

The TypeScript kernels in `packages/tests/engine/scripts/steady/` are stripped once and run
as the same JavaScript in both engines. Each process warms the same functions for at least
1000 ms, then records fifteen batches of at least 100 ms. Sixteen varying seeds per batch
prevent a constant-input comparison. Every call is checked against the pinned Node's result;
an oracle failure, mismatch, missing sample or nonpositive duration fails the run. The driver,
checks and function-call overhead are included in both engines' measured intervals. The fixed
warmup is recorded, not a proof that every workload has reached a stable optimization tier.

The harness alternates engine order between independent processes. It reports the median of
each process's median microseconds per call; all samples, warmup durations, process wall time,
peak RSS, source and binary hashes, commit/dirty state, versions, arguments, CPU, OS and load
averages are saved under `packages/tests/engine/results/steady-*/`. `JIT / V8 > 1` means
Stator is slower. Peak RSS includes startup, warmup and code pages; it is not live heap size.
No claim about all JavaScript follows from these three kernels.

GC tracing (`docs/VALUE.md` §4.12) runs in a separate Stator process, with the same warmup and
measurement driver. Only pauses between its measured-phase markers contribute to the reported
count and p99; raw pauses and post-collection live bytes are retained. This run also proves
that `bench` and `checkedBatch` compiled, rejecting silent interpreter fallback. Another
separate Node process observes `gc` entries through `node:perf_hooks`, filtering entries to the
measured interval by their timestamps and recording their kinds. See Node's
[PerformanceEntry API](https://nodejs.org/api/perf_hooks.html#class-performanceentry), checked
2026-11-08. Raw durations and measured call counts are retained for both engines.

Trace timings never supply the throughput comparison. V8's event durations and Stator's full
collection latency have different instrumentation boundaries; their p99 values alone are not
proof of a faster collector. Neither reports all background GC CPU work. Zero observed
collections is not evidence of zero GC cost. The allocation kernels must actually trigger
collections in the measured phase in both engines; numeric kernels need not allocate. The
object kernel keeps the previous array live across calls; the cycle kernel publishes each
cycle to a global binding, keeping the latest reachable across calls. These test escaping
allocations. Computed-key stores are outside this initial corpus: the baseline JIT rejects
their `to_key` opcode. The compilation proof prevents silently timing that fallback as native
execution; the current three kernels do not establish broader bytecode coverage.

The first three-round baseline and its raw data are recorded in
[`plan/T69/report.md`](../plan/T69/report.md). It does not beat warmed V8 on any of the three
kernels; it is a starting measurement for T67.1, not evidence that the performance goal is met.

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
