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

| Path                  | Holds                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `src/engine.zig`      | `run`: a source in one of the engine's languages (§2), run in one mode, with the outcome |
| `src/cli.zig`         | `stator-engine` (§5)                                                                     |
| `src/jit/analyze.zig` | Which templates the JIT takes, and the operand-stack depth at every instruction          |
| `src/jit/lower.zig`   | Bytecode to pyrlyn/jit IR, with the inline fast paths                                    |
| `src/jit/helpers.zig` | What native code calls for everything else: the VM's own operations                      |
| `src/jit/jit.zig`     | Compile on first call, cache on the template, enter native code                          |
| everything else       | the interpreter, as `packages/engine/README.md` lists it                                 |

## 2. Input languages

| Language | Extensions          | How it runs                                                                                                                                                                                         |
| -------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `js`     | `.js` `.mjs` `.cjs` | parsed by stator-ts's parser, compiled to bytecode                                                                                                                                                  |
| `ts`     | `.ts` `.mts` `.cts` | stator-ts erases the types (`packages/transpiler/src/erase.zig`: parse, bind, emit JavaScript), then as `js`. Types are not checked: a script with type errors runs, as under Node's type stripping |
| `wasm`   | `.wasm`             | named and rejected until plan/T67.3 adds a WebAssembly runtime                                                                                                                                      |

Compiling JavaScript or TypeScript _to_ WebAssembly (plan/T67.2) and to Zig source (plan/T67.4)
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
- `%` on two integer-valued doubles with magnitudes below `2^53` and a nonzero divisor:
  guarded integer conversion and signed remainder, preserving the dividend's sign for zero.
  Fractions, larger magnitudes, nonfinite values, zero divisors and coercions use the VM's
  existing remainder operation;
- `++`, `--`, unary `+` and unary `-` on a double (`-x` is `x * -1`, so `-0` and `+0` swap);
- `!` on a boolean, and the conditional jumps on `true` and `false`;
- locals, arguments, constants and the TDZ check of a checked local;
- `o.k` and `o.k = v` on a dynamic object whose shape the site's inline cache holds: a shape
  compare and a slot load or store, falling to the helper when the object is frozen, the slot
  holds an accessor or the shape differs. The key `constructor` always takes the helper. A store
  reads the collector's dirty bit from the object's header and calls the write barrier only for
  an object the collector has not logged yet (`JSRT_GC_HEADER_BYTES`, `JSRT_GC_DIRTY_BIT`);
- `{ a: x, b: y }`: the literal allocates the object and the slots for its named members as one
  block (`jsrt_dynobj_new_sized`), and each member's `define` keeps the shape step it took last
  (`bytecode.Transition`: the shape before, the shape after, the slot). While the object arrives
  with that shape the member is a shape compare, a slot store and a shape store. A duplicate key,
  a spread, `__proto__` or a first run takes the helper, which walks the transition and fills
  the site;
- `a.length`, `a[i]` and `a[i] = v` on an array: the length is the array's own field, boxed as a
  double; an element at an integer index below the length is loaded or stored in place (a store
  after the same write-barrier check on the array). A hole, an index at or past the length, a
  fraction or a name takes the helper, as does every receiver that is not an array;
- a global read inline, on the global object's shape, through the cache the interpreter keeps per template and key;
- `a.m` about to be called on an array with no own properties: the bound method this
  activation cached for that array (`vm.getMethod`'s two window slots per site), compared and
  loaded in place. The helper binds the method and fills the cache on a miss, so a loop of
  `a.push(v)` binds once instead of allocating a bound closure per call;
- `a.push(v)` itself: a callee that is the method cached for this receiver is the runtime's own
  `push` bound to that array, so an array with room takes the element and the new length in
  place. A full array, another callee or more than one argument takes the call helper;
- sloppy `this` (nullish becomes the global object) and a constructor's return on a plain call;
- a call from compiled code to a plain function the JIT has compiled: the callee's window opens
  above the caller's and its code runs at once, with none of the interpreter's call layers
  between (`vm.callCompiled`). The thread's stack pointer, frame chain, stack limit and pending
  flag are read once where the interpreter enters native code and handed down from there, since
  each thread-local read is a function call on macOS;
- a pure push followed by a store to a local nothing reads (the prologue's `this`, `new.target`,
  `home` and `callee` when the body does not use them) is not emitted.

**The fast chain (AArch64).** Inside one straight run of bytecode the lowerer remembers what
each window slot holds: the register it was loaded into or computed in, whether it is a double,
whether it is past its TDZ, and the constant when the bytecode names one (`lower.zig`, `Known`).
Constants, moves between locals and operands, `+ - * / %` and the comparisons on doubles, and
the fused local forms then guard and load each operand once per run instead of once per
instruction, and a comparison the next instruction jumps on becomes the branch, with no boolean
written. A result stays in its register and is stored in the window only when something
other than the chain may read it there: before a call, before a jump and at the end of the run
(`lower.zig`, `flush`). An operand that was popped before then is never stored, and a local
written twice is stored once. A guard stores nothing on the path that passes it. What the
window lacks where the guard stands (`owed`: the values still in registers, and the shape word
and unfilled slots of a literal that is not whole yet) is stored in a block of its own that only
the failing guard runs, laid out after the run's blocks (`payOwed`), so the window is current
when the generic code is reached and the chain's own code pays nothing for a guard that never
fails. A guard that owes more than eight stores has them made before it instead. The two paths
of the chain that call but seldom run, the allocator's when the run has no room and the
remainder's division, make their stores at their head in the same way. A
guard that fails (an operand that is not a double, a local in its TDZ,
a remainder that is not an integer's or is a zero of a non-positive dividend, a read below
that its cache or its array does not answer) then
branches to the same instruction in a second, generic copy of the run, which finishes it with
the fast paths and helpers above and rejoins at the next run. The generic copies are emitted
after all the fast code and nothing is remembered across an instruction lowered generically,
because pyrlyn/jit keeps no float register across a call. x86-64 has only the generic code: its
results must be read back from the window to make their NaN canonical.

A remainder on the chain divides only when it has to. A dividend from zero up to the divisor is
its own remainder, and one below twice the divisor leaves their difference, which is exact for
doubles; those two cases are two comparisons and at most a subtraction, with no conversion to
an integer. Anything else (a negative dividend, a larger one, a NaN) takes the guarded integer
division. The wrap of an index or of a running sum, `i = (i + 1) % n`, is the common case.

An object a literal makes inside a run is followed too (`lower.zig`, `Object`), until an
instruction without a form runs: nothing else has seen it yet, so its shape and the value in
each of its slots are known when the function is compiled. A named member takes its shape step
then (`jsrt_shape_transition`) and is a slot store, with nothing compared; a member named
twice, and a write of a property the object has, store into the same slot again; a read of a
property it has is the register or constant that was stored, with nothing loaded from the
object. The shape is stored once, the one the literal has reached, before the next call
or end of the run (`flush`), or by a guard that fails: until then nothing else can look at the
object. A store into the
literal checks no write barrier: a block is dirty from its allocation until a collection, only
a call collects, and the chain calls nothing while it follows a literal. Reads and
writes of captured variables keep all of this, because they run none of the program's code. A
literal of more than eight named members, the keys `constructor` and `__proto__`, a property
the object lacks, and everything after a call, a getter, a spread or a computed key take the
paths above.

Such a literal is also allocated on the chain, with no call: the block is taken from the open
run of the collector's young region (docs/VALUE.md §4.12, `JSRTYoungSite`) by moving the run's
pointer down and writing the block's two prefix words, by which the collector finds the block
if anything asks about it, and the object's header and slots are written in place. A slot is
written once: with its member, or with zero when no member has filled it by the time the chain
can be left. A run with no room, which is where a collection starts and what the run reads as
while another thread may allocate, is a guard that fails: the generic copy of the instruction
calls the allocator, and the chain itself calls nothing for a literal, so no register of the
chain lives across a call for one. In a build with no region the literal has no form on the
chain. The literals of a stretch of the chain with no guard in it are taken from the run
together (`place`): the first one's test and move of the run's pointer take the bytes of all
of them, 256 at most, which fits any run that has room at all, since none is shorter than a
line of the region. A guard between two literals ends the stretch, because the code it leaves
for may ask the collector about the run, and every block of the run must have its prefix by
then. The two header words that are always empty, `frozen` and the prototype, are cleared by
one 16-byte store. A captured
variable is read and written in its environment directly, the frame's own or one a fixed
number of parents out, and one the compiler could not rule the TDZ out for leaves the chain
when it is uninitialized; an environment is always dirty to the collector, so the store checks
no barrier. A constant the bytecode pushes that is no number (`null`, `undefined`, a boolean,
the TDZ marker) is made again where it is stored, not read back from the window.

Three reads have forms on the chain as well, and none of them writes the heap or calls on the
path that succeeds (`chained`). A property named by a plain key is read as `cachedProp` reads
it, through the site's inline cache: the value must be a dynamic object of the shape the cache
holds, and the slot must hold a value and no accessor pair. `array[index]` is read as `getElem`
reads it: the value must be an array, the index a double that is an integer below the length,
and the element no hole. `i < array.length` and `i <= array.length`, as the comparison fused
with its jump (`lt_local_prop`), read the length as the field of the array it is; any other
read of `length` calls its helper, as a string or an object answers it as often. Each of those
conditions is a guard, and the generic code a failed one leaves for runs the helper, which
fills the cache, calls the getter, walks the prototype chain or answers for a string as before.
What a read loads has no known type, so the arithmetic that takes it guards that it is a
double. A function is compiled before its caches are filled, so the first time through such a
read leaves by its guard, and the helper fills the cache the chain reads afterwards.

**Loops with carried locals (AArch64).** A loop whose every instruction has a form on the fast
chain makes no call on that chain, so its numeric locals can stay in float registers from one
iteration to the next. `carriedLoops` picks those loops, outermost first, and for each the
locals it computes with and stores nothing but doubles into (`carriedIn`), eight at most. Every
block of such a loop is then lowered with two entries. The window entry, where code outside
the loop and the generic copies arrive, guards that each carried local is a double, loads it
into its register and goes on in the register entry; the register entry, which the loop's own
jumps use, starts with those registers known. Before a block of the loop ends, each carried
local's current value is copied into its register. The window is written at the block's end
and on the path of a guard that fails, as on any chain, so a failed guard leaves for the
generic copy as anywhere else, and comes back through a window entry. The reads above have
forms, so a loop over an array's elements and their properties is such a loop, and so is one
that makes literals: whether the chain takes a literal's instructions depends on what it knows
where it meets them, so `carriedLoops` asks by lowering the loop once into a function it
throws away (`takenWhole`).

Inside such a loop the window is written less than on any other chain. A jump to another block
of the loop stores no carried local: the next block reads the registers, a jump out of the
loop goes through a block of its own that stores them (`edge`), and a failing guard stores
what it owes as elsewhere, up to sixteen stores. A constant that takes the backend more than
one instruction (a tag, a shape, a class, a block's prefix word, the run's address) is made
once, where the loop is entered through a window entry, and kept in a register while the
register copy of the loop runs, eight integer and eight float constants at most (`pooled`).
A double that was read from a local and is still in its slot is loaded into a float register
from that slot, wherever its copies have been moved since (`atHome`).

A function with such a loop is laid out in the order its blocks were written, which
keeps a loop's blocks together: a block a forward jump names is created early, and a carried
register whose life spanned that block's calls would be kept in memory by the backend. The
blocks of the loop that seldom run, its window entries and the dividing arm of a remainder,
are laid out after its other blocks (`seldom`): the backend drops a jump to the next block, so
an iteration that runs none of them takes one branch, where it took one more around each.

Everything else (mixed operands, strings, a cache miss, calls, environments, construction,
`throw`) calls a helper in `helpers.zig` that runs the VM's own function for the
operation. A helper answers 1 when it left an exception pending; the code then leaves through its
exit block, and the interpreter frame that called it unwinds as for any other throw.

**Backends.** pyrlyn/jit (pinned by commit in `build.zig.zon`) allocates registers and emits
AArch64 or x86-64 (System V). Only the AArch64 path has run so far: the x86-64 one compiles
but is unverified until a Linux x86-64 run. A Windows or other host has no backend; `jit` mode prints that and
interprets.

**What it is not yet.** A direct call still goes through one helper that checks the callee and
opens its frame; every object but a literal on the fast chain is a call into the allocator,
and a dynamic object with two properties is an 88-byte block; a call of any native method
but `push` goes through the call helper and the runtime's method dispatch; a number is always
a double, so a remainder that does divide converts to an integer and back, and so does every
index; an array's address, length and elements are read again at each element, and a value a
read loaded is guarded again where a copy of it is used. Integers in registers, what a loop
does not change kept across its iterations, and the optimizing tier (plan/T67.1:
type feedback, call inline caches, deoptimization) are the next steps.

## 4. Tests and benchmark

| Command                     | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run interp:test`      | The engine's Zig tests; every interpreter test runs in both modes, and the JIT tests assert the templates were compiled. In test builds every helper the JIT calls is counted (`helpers.counted`), and `jitCost` tests pin how often each runs: a numeric loop calls none, a cached property read misses once per site, a global read once per function and name; they also pin how often the interpreter enters native code, which a call between compiled functions does not |
| `pnpm run engine:test`      | `packages/tests/engine/run.ts`: every script in `packages/tests/engine/scripts/` under the pinned Node and `stator-engine run` in both modes, and again with the collector collecting on every allocation and recounting the heap (`JSRT_GC_STRESS=1 JSRT_GC_VERIFY=1`), stdout and exit status byte-for-byte; an uncaught error's first line; the CLI's usage errors and not-yet targets                                                                                      |
| `pnpm run engine:bench` | `packages/tests/engine/bench.ts`: the bench programs (the engine-agnostic `ts` set in `packages/tests/bench/programs/`, the memory programs, and the JavaScript ones in `packages/tests/engine/bench/`; one list, `packages/tests/support/bench-programs.ts`) under Node (V8) and `jit` mode, each output checked against Node's, best of N wall time and peak RSS; results in `packages/tests/engine/results/` (ignored). A wrong V8 answer aborts the run; a program the engine cannot run yet is a ✗ with its first error line under the table, never a time. V8 is the only reference |
| `pnpm run engine:bench:zig` | `src/bench.zig`: the `packages/tests/engine/bench/` programs run by the engine inside one process, best of N, with no process or runtime start-up; prints the milliseconds and the templates compiled. `--mode=interp` measures the interpreter                                                                                                                                                                                                                                |

| `pnpm run engine:bench:quickjs` | Identical JavaScript in interpreter mode, QuickJS and optional PrimJS, with pinned Node as output oracle; rotating samples, medians, quartiles and every raw sample |

A measurement, not a claim: 2026-11-08, Apple M3 Max, macOS 27.0, Node v26.7.0, Zig 0.17.1,
`stator-engine` ReleaseFast, best of 5, wall milliseconds from spawn to exit (startup included).

| program             | Node (V8) |  jit | jit / V8 |
| ------------------- | --------: | ---: | -------: |
| fib.ts              |        96 |  282 |     2.94 |
| nbody.ts            |        60 |   26 |     0.43 |
| string-churn.ts     |        56 |   15 |     0.28 |
| json-roundtrip.ts   |        56 |  8.0 |     0.14 |
| hello.ts            |        51 |  7.4 |     0.15 |
| objects-churn.ts    |        80 |  856 |    10.73 |
| objects-retained.ts |       111 | 1002 |     9.03 |
| alloc.js            |        45 |  507 |    11.39 |
| arrays.js           |        55 |  315 |     5.71 |
| closures.js         |        43 |  114 |     2.63 |
| fib.js              |        51 |  112 |     2.19 |
| loop.js             |        59 |  325 |     5.53 |
| methods.js          |        40 |  244 |     6.06 |
| props.js            |        46 |  414 |     9.03 |
| strings.js          |        62 |  204 |     3.31 |

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

T71 remeasured the merged baseline and added the guarded integer `%` path (§3). On the same
Apple M3 Max with Node v26.7.0 and ReleaseFast, three interleaved processes per engine/kernel
gave these medians in microseconds per checked call after warmup:

| Kernel  |     V8 | JIT before | JIT after | After / V8 |
| ------- | -----: | ---------: | --------: | ---------: |
| numeric | 22.252 |    213.642 |   190.008 |       8.54 |
| objects |  4.525 |    238.305 |   237.288 |      52.44 |
| cycles  |  5.402 |    176.106 |   173.089 |      32.04 |

Numeric time fell 11.1%, with nonoverlapping before/after process-median ranges. The object
change is within variation; no object or collector improvement is claimed. Stator remains
slower than V8 on all three kernels. Method, limitations and raw samples are in
[`plan/T71/report.md`](../plan/T71/report.md).

T73 combines the slot-growth write barrier and buffer-owner lookup. Five interleaved
processes on the same machine measured objects at 249.129 → 234.009 us (**6.07% less time**)
and cycles at 172.566 → 156.619 us (**9.24% less time**), with nonoverlapping process ranges.
Numeric was essentially unchanged (169.918 → 170.309 us). V8 took 4.597, 5.449 and 22.431 us
respectively, so this remains an incremental improvement. Both engines' JIT compilation is
verified separately. [The T73 progress report](../plan/T73/progress.md) includes the shared
machine's load, raw samples, rejected experiments and correctness checks; its V8 target stays open.

Later T73 steps (§3: the bound-method cache read in compiled code, a literal's slots allocated
with the object and its shape steps cached, an array's `length` and elements in place, `push`
in place, the collector's young region, docs/VALUE.md §4.12, the fast chain and loop-carried
locals, the remainder that does not divide and the collector's cheaper scan of static roots,
object literals followed, allocated and filled on the fast chain, and then values kept out of
the frame window, a literal's slots written once and its block left for the collector to
index, then the reads on the chain, a guard's stores made where it fails and the
collector's cycle candidates, docs/VALUE.md §4.12, and last the loops that make literals:
carried locals in them, their constants kept in registers, a loop's rare blocks laid out after
it and literals in a row taken from the run together) were measured the same way: five
interleaved processes per engine and kernel, the same machine, Node v26.7.0, ReleaseFast. The
V8 column and the ratio are from the last run; "young region" is the run before the fast
chain, "fast chain" the run before literals were followed on it, "literals" the run before
values were kept out of the window, "lazy stores" the run before the reads, and "reads" the
run before the last changes.

| Kernel  |     V8 | JIT (T73 start) | JIT (young region) | JIT (fast chain) | JIT (literals) | JIT (lazy stores) | JIT (reads) |    JIT | JIT / V8 |
| ------- | -----: | --------------: | -----------------: | ---------------: | -------------: | ----------------: | ----------: | -----: | -------: |
| numeric | 21.906 |         170.309 |            138.221 |           16.710 |         16.513 |            13.420 |      13.473 | 13.359 |     0.61 |
| objects |  4.140 |         234.009 |             25.628 |           21.103 |         16.524 |            15.089 |      10.167 |  9.704 |     2.34 |
| cycles  |  5.451 |         156.619 |             29.259 |           25.099 |          9.996 |             7.097 |       6.648 |  5.084 |     0.93 |

The process-median interquartile ranges do not overlap between the engines on any kernel. On
two of the three Stator is faster than V8: on the numeric kernel, a loop that wraps a running
sum with a remainder (13.316-13.366 us against 21.891-21.978), and on the cycles kernel, a
loop that makes two objects that point at each other and publishes one (5.083-5.101 us against
5.445-5.451; Stator's slowest process, 5.286, is faster than V8's fastest, 5.420). Those are
two loops, not numeric or allocating code in general. On objects it is still slower, by 2.3
times. That kernel fills an array by `push` and reads it back: the read loop asks each element
for the array, its length, the element's shape and the cache again, and converts its index to
an integer each time, and the filling loop still calls for each `push`. A collection there
takes 97 us against 14 on cycles: the array a root holds while it is filled is counted, with
all it holds, and freed one collection later. The machine was shared with other work (load
average between 4.2 and 5.1). The progress report has the profiles, the threshold sweep, the
checks and the raw samples.

### 4.2. Startup and JIT compilation cost (T74)

```sh
pnpm run runtime
node packages/tests/engine/startup.ts --rounds=9
# Optional alternating comparison with an instrumented, prebuilt baseline:
STATOR_ENGINE_BEFORE=/absolute/path/to/before node packages/tests/engine/startup.ts --rounds=9
```

This reuses `engineBinary`, the pinned Node, `timedRun` and the warmed harness's percentile
helper. `STATOR_ENGINE` can select a prebuilt candidate. Cold timings run without tracing:
fresh processes with warm filesystem caches, from spawn through exit, including the timing
wrapper. The trivial script and generated sets of 24 small or larger functions have their
output checked byte-for-byte against Node. All samples, commands, hashes, versions and load
averages are retained under `packages/tests/engine/results/startup-*/`.

Compilation is a separate instrumented run. `STATOR_JIT_TRACE=1` retains its existing messages
and adds `jit-time: NAME compiled|rejected ANALYZE_NS LOWER_NS BACKEND_NS PUBLISH_NS` records.
The successful stages cover bytecode analysis, IR lowering and layout, register allocation and
machine-code emission, and executable-memory publication. Parsing, execution, trace I/O and
temporary-allocation cleanup are outside these stage intervals. Failed stages may have zero
timing; a benchmark requires a successful, positive record for every expected function.
Disabled tracing reads no clocks. The clock is the runtime's existing monotonic `rt_nanos`.

V8 Sparkplug is measured with synchronous, forced baseline compilation and `--trace-baseline`;
TurboFan with prepared feedback, synchronous forced optimization and `--trace-opt`. These
diagnostic flags and the V8-only preparation driver are recorded in the result. Function bodies
are identical; V8 preparation is outside the reported compilation intervals. V8's trace fields
have microsecond resolution and different tier-specific boundaries. Sparkplug and TurboFan
produce different code quality: a smaller compilation total alone does not establish a better
JIT, and forced-tier measurements do not describe default V8 startup scheduling. The parser
targets the pinned Node's trace format and fails on missing or invalid records.

The baseline JIT places acyclic reachable IR blocks in reverse postorder before the existing
backend. The backend computes liveness backwards in block order; allocation-order diamonds previously
required extra fixed-point sweeps. Layout preserves entry, edges, edge arguments and unreachable
blocks. A reachable cycle leaves the original layout intact: the unrestricted ordering trial
regressed the warmed object kernel. Traversal is iterative so large functions do not consume
the native call stack. No second register allocator or optimizing tier is added; T67.1 still
owns that tier.

Nine alternating rounds on Apple M3 Max, macOS 27.0.1, Node 26.7.0, Zig 0.17.1, ReleaseFast:

| Metric (24 functions)                       | Before ms | After ms | V8 Sparkplug ms | V8 TurboFan ms |
| ------------------------------------------- | --------: | -------: | --------------: | -------------: |
| Compile, 8 arithmetic/branch pairs per body |     2.661 |    2.618 |           0.200 |          4.934 |
| Compile, 64 pairs per body                  |    40.153 |   31.786 |           0.974 |         23.942 |

The larger program's untraced spawn-to-exit median fell from 48.204 to 40.052 ms; Node with
default flags took 35.519 ms. The trivial script took 6.005 ms before, 6.034 ms after and 32.507 ms
under Node; overlapping quartiles do not establish a trivial-startup improvement. Compilation
of the larger bodies improved by 20.8%, and their cold process time by 16.9%. Stator remains
slower to compile them than V8, and remains slower than Sparkplug on both sizes. Full evidence
and warmed-execution validation are in the [T74 report](../plan/T74/report.md).

### Comparing the interpreter with QuickJS

Install QuickJS separately, then run after `pnpm run runtime`:

```bash
QJS=/path/to/qjs BENCH_RUNS=7 pnpm run engine:bench:quickjs
QJS=/path/to/qjs PRIMJS=/path/to/primjs/out/Default_snapshot/qjs BENCH_RUNS=15 pnpm run engine:bench:quickjs --require-faster
QJS=/path/to/qjs PRIMJS=/path/to/primjs/out/Default_snapshot/qjs BENCH_RUNS=15 pnpm run engine:bench:quickjs
```

The fixtures in `packages/tests/engine/scripts/bench/` cover numeric loops, recursive calls,
array traversal, object properties, closures, prime sieving and string concatenation. Their
`.ts` files contain JavaScript without annotations: Stator uses `--mode=interp --lang=js`,
QuickJS uses `--script`, and all stdout must match the pinned Node byte for byte. A process's
wall time includes startup and the timing wrapper. One untimed run precedes rotated tool
order; the report includes executable flags, versions, source hashes, the interpreter binary
hash, the source diff and raw samples. The interpreter executable is copied before measuring
so another build cannot replace it midway through a run.

`STATOR_ENGINE` selects a prebuilt interpreter; `STATOR_ENGINE_BASELINE` adds an older
ReleaseFast executable to the same rounds. Results are saved under the ignored `results/`
directory. `--require-faster` fails unless the interpreter's 75th percentile is below both QuickJS's and PrimJS's
25th percentiles on **every** fixture. It does not hide losses or silently switch to JIT.
This is a local benchmark criterion, not a claim about all JavaScript programs or machines.
The owner-requested target and remaining work are tracked in `plan/T70/task.md`.

`PRIMJS` adds [Lynx PrimJS](https://github.com/lynx-family/primjs) to the same rotating rounds
and output checks. Point it at a release executable built using upstream's instructions; on
macOS arm64 use the snapshot interpreter with tracing GC enabled. `PRIMJS_VERSION`,
`PRIMJS_REVISION` and `PRIMJS_BUILD_ARGS` record its provenance (its CLI has no version flag).
The report also hashes that executable and records `--runtime-info`. `--require-faster` requires `PRIMJS` and checks both competitors. A report without PrimJS
can still be produced, but cannot satisfy T70's completion gate.

Local comparison, 2026-11-08, Apple M3 Max / macOS 27.0.1: Zig 0.17.1 ReleaseFast, QuickJS
2026-06-04, PrimJS 2.11.1-rc.1 at `941a365b` (release arm64 snapshot interpreter, tracing GC).
Medians of 15, wall milliseconds including startup:

| Workload | T68 baseline | Stator interp | QuickJS | PrimJS | Speedup over T68 |
| -------- | -----------: | ------------: | ------: | -----: | ---------------: |
| array    |       111.22 |         40.51 |   45.04 |  28.57 |            2.75× |
| closure  |        97.49 |         32.51 |   33.16 |  22.54 |            3.00× |
| fib      |       536.90 |        146.06 |  134.95 |  83.09 |            3.68× |
| loop     |       223.15 |        100.39 |   81.95 |  55.27 |            2.22× |
| objects  |       143.79 |         53.26 |   56.53 |  37.65 |            2.70× |
| sieve    |        64.42 |         22.28 |   24.11 |  18.02 |            2.89× |
| string   |        20.62 |         13.44 |   13.41 |   9.91 |            1.53× |

The changed interpreter is 1.5–3.7 times faster than its T68 baseline. It beats QuickJS beyond
interquartile variation on arrays, objects and sieving; the all-workload gate still fails on
closures, recursion, the numeric loop and strings. PrimJS wins all seven comparisons.
[The T70 progress record](../plan/T70/progress.md) includes checks, build commands and raw samples.

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
