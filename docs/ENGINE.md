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
- a global read inline, on the global object's shape, through the cache the interpreter keeps per template and key;
- sloppy `this` (nullish becomes the global object) and a constructor's return on a plain call;
- a call from compiled code to a plain function the JIT has compiled: the callee's window opens
  above the caller's and its code runs at once, with none of the interpreter's call layers
  between (`vm.callCompiled`). The thread's stack pointer, frame chain, stack limit and pending
  flag are read once where the interpreter enters native code and handed down from there, since
  each thread-local read is a function call on macOS;
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

**What it is not yet.** A direct call still goes through one helper that checks the callee and
opens its frame; every object literal allocates its slots and walks a shape transition per
property; every operand goes through the frame window in memory. Allocation, property-heavy code
and tight numeric loops are where V8 is far ahead (§4); a cached transition per literal and the
optimizing tier (plan/T67.1: type feedback, values in registers, call inline caches,
deoptimization) are the next steps.

## 4. Tests and benchmark

| Command | What it checks |
| --- | --- |
| `pnpm run interp:test` | The engine's Zig tests; every interpreter test runs in both modes, and the JIT tests assert the templates were compiled. In test builds every helper the JIT calls is counted (`helpers.counted`), and `jitCost` tests pin how often each runs: a numeric loop calls none, a cached property read misses once per site, a global read once per function and name; they also pin how often the interpreter enters native code, which a call between compiled functions does not |
| `pnpm run engine:test` | `packages/tests/engine/run.ts`: every script in `packages/tests/engine/scripts/` under the pinned Node and `stator-engine run` in both modes, stdout and exit status byte-for-byte; an uncaught error's first line; the CLI's usage errors and not-yet targets |
| `pnpm run engine:bench` | `packages/tests/engine/bench.ts`: the bench programs (`packages/tests/engine/scripts/` and the JavaScript ones in `packages/tests/engine/bench/`) under Node (V8) and `jit` mode, each output checked against Node's, best of N wall time and peak RSS; results in `packages/tests/engine/results/` (ignored). V8 is the only reference |
| `pnpm run engine:bench:zig` | `src/bench.zig`: the `packages/tests/engine/bench/` programs run by the engine inside one process, best of N, with no process or runtime start-up; prints the milliseconds and the templates compiled. `--mode=interp` measures the interpreter |

A measurement, not a claim: 2026-11-08, Apple M3 Max, macOS 27.0, Node v26.7.0, Zig 0.17.1,
`stator-engine` ReleaseFast, best of 5, wall milliseconds from spawn to exit (startup included).

| program | Node (V8) | jit | jit / V8 |
|---|---:|---:|---:|
| fib.ts | 96 | 282 | 2.94 |
| nbody.ts | 60 | 26 | 0.43 |
| string-churn.ts | 56 | 15 | 0.28 |
| json-roundtrip.ts | 56 | 8.0 | 0.14 |
| hello.ts | 51 | 7.4 | 0.15 |
| objects-churn.ts | 80 | 856 | 10.73 |
| objects-retained.ts | 111 | 1002 | 9.03 |
| alloc.js | 45 | 507 | 11.39 |
| arrays.js | 55 | 315 | 5.71 |
| closures.js | 43 | 114 | 2.63 |
| fib.js | 51 | 112 | 2.19 |
| loop.js | 59 | 325 | 5.53 |
| methods.js | 40 | 244 | 6.06 |
| props.js | 46 | 414 | 9.03 |
| strings.js | 62 | 204 | 3.31 |

The engine starts in under 10 ms against Node's 50, so short scripts favor it. On hot code V8's
optimizing tiers are still 2–11 times faster than this baseline JIT. The inline caches, prologue
trimming and direct calls above took `fib.ts` from 11.2 to 2.9 times V8's time and
`objects-churn` from 15.3 to 10.7; a profile of `loop.js` now spends all its time inside generated code, so the rest of
that gap is the operand stack in memory and the tag checks, which the optimizing tier removes.

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
