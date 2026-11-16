# T73 progress: object storage and collector overhead

This is progress on the creator-directed memory/object scope, not completion of T73.
T67.1 remains assigned to its existing owner. Stator does not yet beat V8 on this corpus.

## Implementation

Sampling the T71 ReleaseFast host on the escaping-object and cyclic-object kernels found
GC allocation/free work, TLS lookup, and owner lookup on the hot paths. In the cycle sample,
`_tlv_get_addr` was the top leaf (129 samples); `jsrt_gc.lock` had 92 and `findBlock` 83.
The object sample had 90 TLS and 86 GC-lock leaf samples. These are statistical samples,
not exact call counts. The top-of-stack excerpts are archived beside this report.

`jsrt_shape_reserve` previously called `gc.write(slots)` and `gc.ownerOf(slots)` separately.
Both resolved the same interior field to its owning collected object under the heap lock.
The combined `writeOwner` operation performs the barrier and returns that owner once.
The C `jsrt_gc_write` ABI delegates to the same implementation; null remains a no-op.
A field in static storage remains its own owner marker, preserving buffer-root handling.

A paired-TLS-record experiment was also measured initially, then removed. Inspecting the
binary with `nm` showed LLVM had split each aggregate back into two TLS symbols; the intended
reduction in TLS resolutions was not present. The final comparison isolates the combined
owner lookup. Object/buffer layouts, capacity growth, retirement and locking are unchanged.

The roots regression grows an object past several capacity boundaries while forcing collection
on every allocation, then checks all 40 child objects. It also grows a static slot table and
checks its referenced string survives. It passes with the collector's full count verifier.

An inline-four-slot experiment was rejected before publication. After growth, a native local
can still point into old slots. The existing retired-buffer machinery preserves references in
that storage; tracing only a new out-of-line table would not. Keeping stale inline references
unconditionally would instead change reclamation/WeakRef behavior. This change does not alter
that lifetime contract.

## Measurement protocol

Both hosts use Zig 0.17.1 ReleaseFast and the normal runtime archive (C `-O2`, Zig ReleaseSafe,
no LTO). The machine is Apple M3 Max, arm64 macOS 27.0.1. The pinned oracle is Node v26.7.0,
V8 14.6.202.34-node.28, with its default JIT settings. `NODE_OPTIONS` is cleared. GC stress,
verification and trace output are disabled for throughput measurements.

The unchanged T69 kernels publish allocations across calls. Each process warms for at least
one second, then records fifteen samples of at least 100 ms. Every batch checks all sixteen
seed answers against Node. Five separate processes per tool/kernel rotate baseline, changed
and V8 order. Reported times are medians of process medians in microseconds per kernel call;
compilation and process startup are outside the timed loop. All rows and raw samples are kept.

`compare.ts` reuses the existing timing/protocol parser. Its arguments are immutable baseline
and changed host copies and a generated corpus directory from the existing `steady.ts` harness:

```bash
mise exec -- pnpm run runtime
mise exec -- zig build steady -Doptimize=ReleaseFast --build-file packages/engine/build.zig
# Copy packages/engine/zig-out/bin/stator-steady at each revision before rebuilding.
mise exec -- node packages/tests/engine/steady.ts --rounds=5
mise exec -- node plan/T73/compare.ts BASELINE CHANGED GENERATED_CORPUS
```

Separate `node --trace-opt --require GENERATED_CORPUS/clock.cjs KERNEL.js` runs prove that
V8 optimizes both `bench` and `checkedBatch` through TurboFan. Separate Stator trace runs
prove both functions compiled. Instrumented times are excluded from throughput results.

The exploratory series at f3f36ce5 is retained as `initial-interleaved.json`. Its median times
were: numeric 187.551 → 185.836 us (V8 22.346), objects 243.271 → 231.112 us (V8 4.420),
cycles 179.070 → 159.131 us (V8 5.451). The final cycle rounds encountered substantial load
variation (baseline round 4 reached 315.891 us and V8 10.199 us). No rows were discarded.
After integrating T70, the comparison is repeated against the same merged sources on both
sides so interpreter changes cannot be credited to this runtime patch.

## Final five-process comparison

Baseline host: `53c8546e` (T71 plus T70). Final source base: `668c1fef` (also incorporating
T72's test-harness changes); `git diff 53c8546e HEAD -- packages/runtime packages/engine
packages/tests/engine` was empty before this patch. The final measurement excludes the rejected
TLS experiment. Executable/source hashes, load, flags, peak RSS and all samples are in
[`interleaved.json`](interleaved.json); [`jit-proof.txt`](jit-proof.txt) records both engines'
compilation proof. Warmup finished after V8's TurboFan compilations in all three trace runs.

| Kernel  |  V8 us | Stator before us | Stator after us | Time reduction | After / V8 |
| ------- | -----: | ---------------: | --------------: | -------------: | ---------: |
| numeric | 22.431 |          169.918 |         170.309 |         -0.23% |       7.59 |
| objects |  4.597 |          249.129 |         234.009 |          6.07% |      50.91 |
| cycles  |  5.449 |          172.566 |         156.619 |          9.24% |      28.74 |

Before/after process-median interquartile ranges (nearest rank, as in the existing harness):
numeric 169.888–171.079 / 168.919–171.023 us; objects 243.195–251.171 / 231.899–234.617 us;
cycles 171.449–173.685 / 156.370–157.949 us. The full ranges also do not overlap for objects
and cycles. Numeric overlaps and is slightly slower at the median: no numeric gain is claimed.

This was a shared workstation: load averages went from 13.75/17.10/18.08 to
23.91/19.10/18.68. All measurements remain in the report, including the 278.410-us baseline
object run and 5.405-us V8 object run. Interleaving and the separated before/after ranges
support a local gain, not a universal percentage or a cross-platform performance claim.

## Validation and remaining work

[`checks.txt`](checks.txt) records the full local `mise exec -- pnpm run ci` output: exit 0,
837 unit tests, 1010 subset passes plus 31 expected failures, 525 golden passes, 22 selfhost
targets matching the baseline, generated Node docs current, and all four leak workloads
at a plateau. The full ASan/UBSan golden pass also has 525 passes. The two optional Intl
fixtures are explicitly skipped. FFI's ASan selection has 7 passes and 15 intentional skips.

`pnpm run interp:test` exits 0. `JSRT_GC_VERIFY=1 pnpm run engine:test` reports
`engine: 58 passed, 0 failed`. The sanitized runtime corpus matches Node, and the roots
regression prints `roots ok` with `JSRT_GC_VERIFY=1`. After integrating T72, the complete unit suite reports **840 passes in 66 files**;
that merge changes no measured engine/runtime source. No dependencies, GC layouts, test expectations or benchmark kernels were changed.

Peak RSS in the full leak checks: 10M objects 11872 KB, 10M FFI strings 12640 KB,
2M computed-key reads 12352 KB, and 2M garbage cycles 16800 KB, all below the 65536 KB cap.

T73 remains **in progress**: the complete performance Check fails because Stator still loses
to V8 in every kernel. No `done.md` is created. The measured optimization is suitable to land
independently while the optimizing JIT task T67.1 continues under its existing owner. No
plan-notes entry was required: this follows the existing collector contract and adds no dependency.

## Literals and arrays (2026-11-16)

After the card passed to one agent with T67.1, on pyrlyn/gc `ef3b440` and pyrlyn/jit `e90d570`.
Four changes, each profiled with macOS `sample` on the ReleaseFast `stator-steady` host and
measured before the next:

1. `2044cb0c`: compiled code reads the activation's bound-method cache, so `retained.push`
   stops allocating an environment and a bound closure per call.
2. `45bd36cb`: `defineOwn` applies the collector's write barrier. This is a correctness fix
   found on the way: an old object that gained a property through a class field or a spread
   could keep a reference the collector had not counted. `engine:test` now runs every script
   under `JSRT_GC_STRESS=1 JSRT_GC_VERIFY=1` as well; 34 of those runs fail without the fix.
3. `e8a79b20`: a literal allocates its slots with the object (`jsrt_dynobj_new_sized`), each
   `define` site caches its shape step, and compiled code takes a cached step and tests the
   collector's dirty bit in place.
4. `7f72a818`: an array's `length` and its indexed reads and writes in compiled code.

One process per engine and kernel after each change, microseconds per checked call:

| Kernel  | Start |      After 1 | After 3 | After 4 |
| ------- | ----: | -----------: | ------: | ------: |
| cycles  | 156.6 |        141.2 |    43.9 |    45.4 |
| objects | 234.0 |        113.4 |    61.2 |    43.1 |
| numeric | 170.3 | not recorded |   134.3 |   135.2 |

"Start" is the previous section's five-process result. None of the four changes touches
arithmetic: the numeric difference from "Start" predates them (the dependency update
`6d049881` and the merges since) and was not bisected.

Five interleaved processes per engine and kernel at `7f72a818`, clean tree, Apple M3 Max,
Node v26.7.0 (V8 14.6.202.34-node.28), Zig 0.17.1 ReleaseFast, load averages 7.75/7.18/9.27
before and 10.19/8.13/9.43 after. Samples, warmups, process times, peak RSS and source hashes
are in [`literals-arrays.json`](literals-arrays.json):

| Kernel  |  V8 us | V8 IQR        | Stator us | Stator IQR      | Stator / V8 |
| ------- | -----: | ------------- | --------: | --------------- | ----------: |
| numeric | 22.385 | 22.373-22.390 |   138.158 | 137.896-138.184 |        6.17 |
| objects |  4.379 | 4.378-4.391   |    45.885 | 44.432-47.835   |       10.48 |
| cycles  |  5.428 | 5.405-5.430   |    45.171 | 45.046-45.936   |        8.32 |

The compilation proof of that run lists `bench` and `checkedBatch` compiled in all three
kernels. The script itself is still interpreted (`rejected: opcode array_push`); it only
drives the loop.

Checks at `7f72a818`: `pnpm run interp:test` exits 0; `pnpm run engine:test` reports
`engine: 92 passed, 0 failed` (46 runs, each also under collector stress and verification).
At `e8a79b20`, the last runtime change: `pnpm run test` 844 passed in 67 files, `test:golden`
525 passed, `test:asan` 525 passed, `test:runtime` matches Node with `roots ok`, `test:leak`
four plateaus (peak RSS 11776, 11680, 11856 and 15984 KB of a 65536 KB cap), `pnpm run dupes`
0 clones.

Where the time is now (same profiler, `7f72a818`). Cycles: 68% is the allocator (the pool,
zeroing the block, the block index, the young list, then finalizing and freeing each dead
object), 25% is generated code, 4% the store to the script's `cycleRoot` binding. Objects: 34%
is `retained.push` (the call helper, `jsrt_call_with_this`, the method dispatch, `array_store`),
37% the allocator, 27% generated code. Numeric: generated code only, every operand through the
frame window.

The Check still fails on every kernel, so the card stays open. Steps 9 and 10 in `task.md` are
what these profiles ask for next, with T67.1 step 3 for numeric.

## Push and the young region (2026-11-16)

Two more changes on the same dependencies, profiled and measured the same way:

1. `008e2a5f`: `a.push(v)` in compiled code. A callee that is the method the activation cached
   for this receiver is the runtime's own `push` bound to that array, so an array with room
   takes the element and the new length in place.
2. `153ec14a`: the memory core allocates blocks of 512 bytes or less by moving a pointer
   through a young region (one 64 MiB reservation in 512-byte lines, docs/VALUE.md §4.12). A
   collection clears the index words of the lines its runs used and marks the survivors
   again, so a dead young object costs no finalizer call, no free and no read of its memory.
   Only young objects with something to finalize are listed; a dynamic object is listed when
   a buffer first names it as owner. Larger blocks, buffers and the sanitized flavor stay on
   pyrlyn/gc's pools.

`0854a4c5` between them only removes two clones `pnpm run dupes` found in the lowerer.

One process per engine and kernel after each change, microseconds per checked call:

| Kernel  | At `7f72a818` | After 1 | After 2 |
| ------- | ------------: | ------: | ------: |
| cycles  |          45.2 |    44.6 |    29.0 |
| objects |          45.9 |    33.6 |    25.0 |
| numeric |         138.2 |   138.1 |   137.0 |

Five interleaved processes per engine and kernel at `153ec14a`, clean tree, Apple M3 Max,
Node v26.7.0 (V8 14.6.202.34-node.28), Zig 0.17.1 ReleaseFast, load averages 5.48/7.09/8.02
before and 6.16/6.88/7.84 after. Samples, warmups, process times, peak RSS, source hashes and
the compilation proof are in [`young-region.json`](young-region.json):

| Kernel  |  V8 us | V8 IQR        | Stator us | Stator IQR      | Stator / V8 |
| ------- | -----: | ------------- | --------: | --------------- | ----------: |
| numeric | 22.423 | 22.350-22.509 |   138.221 | 138.147-138.442 |        6.16 |
| objects |  4.319 | 4.314-4.348   |    25.628 | 25.523-25.765   |        5.93 |
| cycles  |  5.373 | 5.370-5.429   |    29.259 | 29.176-29.385   |        5.45 |

Stator's full-collection latency in the instrumented runs: p99 0.074 ms over 1068 collections
on cycles (0.458 ms before the region) and 0.216 ms over 715 on objects.

Checks at `153ec14a`: `pnpm run interp:test` exits 0; `pnpm run engine:test` reports
`engine: 92 passed, 0 failed`; `pnpm run test` 844 passed in 67 files; `test:golden` 525
passed; `test:asan` 525 passed; `test:runtime` matches Node with `roots ok`; `test:leak` exits
0; `pnpm run dupes` 0 clones. One earlier `test:golden` run, started while a profiler and a
benchmark were loading the machine, printed `ts/node_timers.ts`'s 10 ms timer and its interval
in the other order; the run on an idle machine and the sanitized run both pass, and the
fixture's order depends on wall-clock timers, not on the collector.

Where the time is now (same profiler, the tree of `153ec14a`). Cycles: 56% generated code,
22% the young allocation (its stalls are the first writes to cold lines: the index word and
the header; each object is 88 bytes), 7% `jsrt_dynobj_new_sized`, 5% the `new_object` helper,
4% `store_env`, 6% root scanning and collection. Objects: 75% generated code, 14% the young
allocation. Numeric: generated code only.

The Check still fails on every kernel, so the card stays open. Generated code is the largest
share of all three: every operand is loaded from the frame window and every arithmetic
operand is guarded as a double again. Steps 11 to 14 in `task.md` follow from that.

Found on the way and not fixed here: an array method read as a value stays bound to the array
it was read from (`const p = a.push; p.call(b, 9)` pushes onto `a`, in both modes).

## The fast chain and carried locals (2026-11-16)

Two changes to the lowerer, AArch64 only, on the same dependencies:

1. `a712c3fc`: the fast chain. Within a straight run of bytecode the lowerer remembers what
   each window slot holds: the vreg it loaded or computed, whether it is a known double, a
   constant. A chain of arithmetic guards and loads each operand once, a comparison and the
   jump after it are one branch, and a guard that fails leaves for a generic copy of the run
   from the guarded instruction on, emitted after the function's main code. Window stores
   stay eager, which is what lets a guard leave from anywhere.
2. `2d71565d`: loop-carried locals. A loop whose every instruction has a fast form (so it
   makes no call) carries up to eight numeric locals in float registers from one iteration to
   the next. Each of its blocks has a window entry, which guards and loads the carried locals,
   and a register entry the loop's own edges take. Such functions are laid out in the order
   their blocks were filled, so the loop body stays in one piece.

Microseconds per checked call after each change. The first column is the five-process record
above; "After 1" is five processes on the working tree before its commit, "After 2" one
process:

| Kernel  | At `153ec14a` | After 1 | After 2 |
| ------- | ------------: | ------: | ------: |
| cycles  |          29.3 |    26.1 |    25.6 |
| objects |          25.6 |    21.4 |    22.3 |
| numeric |         138.2 |   104.2 |    87.5 |

Five interleaved processes per engine and kernel at `2d71565d` (the tree's only difference
from the commit was this card's `task.md`), Apple M3 Max, Node v26.7.0 (V8
14.6.202.34-node.28), Zig 0.17.1 ReleaseFast. The machine was shared with other work: load
averages 12.72/9.60/9.20 before and 12.70/10.41/9.55 after, against 5 to 8 for the earlier
records. Samples, warmups, source hashes and the compilation proof are in
[`carried-locals.json`](carried-locals.json):

| Kernel  |  V8 us | V8 IQR        | Stator us | Stator IQR     | Stator / V8 |
| ------- | -----: | ------------- | --------: | -------------- | ----------: |
| numeric | 22.459 | 22.403-22.588 |    89.619 | 89.509-102.053 |        3.99 |
| objects |  4.676 | 4.674-4.685   |    22.356 | 22.351-22.485  |        4.78 |
| cycles  |  5.590 | 5.579-5.608   |    26.386 | 26.264-26.490  |        4.72 |

Numeric's per-process medians were 89.619, 102.053, 89.049, 89.509 and 103.392 us: two
processes ran a seventh slower, which the load explains better than the code does, and V8 had
one such process too (26.118 us among four at 22.4 to 22.6). Stator's full-collection latency
in the instrumented runs: p99 0.099 ms over 1203 collections on cycles and 0.258 ms over 837
on objects.

Checks at `2d71565d`, each step of `pnpm run ci` run on its own (`oxfmt --check` trips over an
untracked local settings file, so `lint` was `oxlint --deny-warnings .`, clean): `typecheck`
and `check-js-sources` exit 0; `pnpm run dupes` 0 clones; `zig fmt --check` clean; `pnpm run
test` 844 passed in 67 files; `test:runtime` matches Node with `roots ok`; `test:subset` 1010
passed, 31 expected-fail, 0 failed; `test:golden` 525 passed; `test:selfhost`,
`test:builtins`, `test:node-coverage` and `test:leak` exit 0; `test:asan` 525 passed; `pnpm run
interp:test` exits 0; `pnpm run engine:test` reports `engine: 92 passed, 0 failed`.

What the numeric loop's machine code shows (the IR and code dumped through a temporary patch
to `jit.zig`, not committed). The carried locals are where they should be: `sum` in `d0`, `i`
in `d1`, with no load from the window on the loop's path. What is left is the arithmetic
itself. `(sum + i) % 65521` is `fadd`, a conversion to an integer with its range fix-up, `sdiv`,
`msub` and a conversion back, all on the dependency chain from one iteration's `sum` to the
next: 28 to 35 cycles an iteration by the instructions' latencies and 8.75 ns measured, where
V8's whole iteration takes about 2.2 ns.
Beside it each iteration still writes about six results to the frame window, because a guard
may leave from any of them. Steps 15 to 17 in `task.md` follow from that; 12 and 13 (a
literal's allocation and the environment accesses in place) are what the object and cycle
kernels wait for.

The Check still fails on every kernel, so the card stays open.

## A remainder without a division, and the collector's static roots (2026-11-16)

Two changes, each from a profile:

1. `1cd51a49`: on the fast chain `a % b` no longer divides when it does not have to. A dividend
   that is not negative and below the divisor is the result; one that is below twice the
   divisor is the result after one subtraction, which is exact. Anything else, a NaN included,
   takes the guarded integer division as before. The wrap of a running sum or of an index is
   one of the first two cases almost every time, so the numeric kernel's loop lost the
   conversion to an integer, the `sdiv` and the conversion back from its dependency chain.
   This replaces step 17 (a remainder by a constant as a multiplication and a shift) and takes
   what step 15 (integers in registers) was for out of this kernel.
2. `31bd814b`: a collection read every writable segment of the image as roots, one call a
   word. A `sample` profile of the cycle kernel put three quarters of a collection there: the
   host's `__DATA` is 440 KB, of which 262 KB are the templates thread-local buffers are copied
   from and 134 KB zero-filled storage. Mach-O sections are now added one by one without the
   thread-local templates, which nothing is ever stored in, and a word outside the heap's
   address range is dismissed before the block lookup. The mean pause on the cycle kernel went
   from about 80 to 24 microseconds.

The threshold between collections was swept before and after the second change, one process
each, microseconds per checked call:

| Between collections | cycles, before | objects, before | cycles, after | objects, after |
| ------------------- | -------------: | --------------: | ------------: | -------------: |
| 1 MiB               |         35.388 |          34.806 |               |                |
| 2 MiB               |         29.172 |          26.835 |        26.427 |         25.516 |
| 8 MiB (kept)        |           27.8 |            22.2 |        25.166 |         20.683 |
| 32 MiB              |         25.115 |          19.875 |        24.991 |         21.152 |

A smaller young region does not pay: the pause has a fixed part (the stacks, the index of the
region) that a collection every 2 MiB repeats four times as often, and the object kernel's pause
is the tracing of the arrays it retains. 8 MiB stays.

Five interleaved processes per engine and kernel at `31bd814b` on a clean tree, Apple M3 Max,
Node v26.7.0 (V8 14.6.202.34-node.28), Zig 0.17.1 ReleaseFast, load averages 9.62/10.56/10.47
before and 8.15/9.82/10.19 after. Samples, warmups, source hashes and the compilation proof are in
[`remainder-and-roots.json`](remainder-and-roots.json):

| Kernel  |  V8 us | V8 IQR        | Stator us | Stator IQR    | Stator / V8 |
| ------- | -----: | ------------- | --------: | ------------- | ----------: |
| numeric | 22.352 | 22.325-22.483 |    16.710 | 16.701-16.856 |        0.75 |
| objects |  4.398 | 4.361-4.441   |    21.103 | 20.853-21.106 |        4.80 |
| cycles  |  5.407 | 5.373-5.417   |    25.099 | 25.091-25.167 |        4.64 |

On the numeric kernel Stator's slowest process (16.859 us) is faster than V8's fastest
(22.285 us): that third of the Check holds. It is one loop of one shape, a sum wrapped by a
remainder, and says nothing of numeric code in general. Stator's collections in the
instrumented runs: 1252 on cycles with a mean pause of 24.2 us, 890 on objects with 131.0 us.

Checks at `31bd814b`, each step of `pnpm run ci` on its own as before: `check-node`,
`check-js-sources`, `typecheck`, `oxlint --deny-warnings .`, `dupes` (0 clones), `zig fmt
--check` and `pnpm run runtime` exit 0; `pnpm run test` 855 passed in 68 files;
`test:runtime` exits 0; `test:subset` 1010 passed, 31 expected-fail, 0 failed; `test:golden`
547 passed; `test:selfhost`, `test:builtins`, `test:node-coverage` and `test:leak` exit 0;
`test:asan` 547 passed; `pnpm run interp:test` exits 0; `pnpm run engine:test` reports
`engine: 92 passed, 0 failed`.

Where the object kernels stand (`sample`, the cycle kernel after both changes): generated code
59% of the samples, `allocYoung` 23%, `jsrt_dynobj_new_sized` 8%, the `store_env` and
`new_object` helpers 4% and 3%, the collection 1%. An iteration is about 100 cycles against
V8's 22. The allocation is three calls deep for what is a bump, an index bit and nine stores;
the generated code asks the object for its class, its shape, its capacity and its slots at
every `define` and every read, though the literal was made two instructions earlier. Steps 12,
13 and 18 in `task.md` follow from that.

The Check still fails on objects and cycles, so the card stays open.

## Literals on the fast chain, allocated in place (2026-11-16)

Steps 18, 12 and 13 of `task.md`, then what the machine code of the cycle kernel showed.
Each row is the median of five interleaved processes per engine, as before; V8 moved by less
than 3% between the runs.

| Change                                       | Record                                                 | cycles us | objects us | numeric us |
| -------------------------------------------- | ------------------------------------------------------ | --------: | ---------: | ---------: |
| before (`31bd814b`)                          | [`remainder-and-roots.json`](remainder-and-roots.json) |    25.099 |     21.103 |     16.710 |
| literals on the fast chain (`5bfaff0b`)      | [`literals-on-chain.json`](literals-on-chain.json)     |    15.919 |     18.764 |     16.574 |
| the allocation and captured variables inline | [`inline-allocation.json`](inline-allocation.json)     |    15.623 |     16.205 |     16.727 |
| one slow path, one shape store, fewer checks | [`shape-and-tdz.json`](shape-and-tdz.json)             |     9.996 |     16.524 |     16.513 |

1. **Literals on the fast chain** (`5bfaff0b`). A literal made in a run of bytecode is followed
   by the lowerer: `define` is a store into a slot whose offset the shape table gave when the
   function compiled, a read of a property it has is the value that was stored, and a write of
   one is a store. Nothing asks the object, the shape table or a cache until an instruction
   without a form runs. A literal that has lived through a call takes the write barrier.
2. **The allocation inline.** The young region's open run is two words the runtime exports
   (`JSRTYoungRun`, `docs/VALUE.md` §4.12). The compiled code bumps it, sets the block's start
   bit, writes the header and the object's words, and calls the allocator only when the run is
   full. The run reads as full while another thread may allocate, under `JSRT_GC_STRESS`, and
   in the sanitized flavor, which has no young region; all three keep the call.
3. **Captured variables in place.** `load_env` and `store_env` walk the environment chain in
   compiled code; a variable still uninitialized leaves the chain for the generic instruction,
   which throws.

After 2 the cycle kernel had moved by 2%. The machine code said why: the allocator's call sat
in the middle of the run, so every value the lowerer held across it needed one of the ten
call-preserved registers, and the register allocator, whose intervals have no holes, spilled
the window base and reloaded it at each of 187 uses. The slow path now comes after the fill in
block order and shares no value with it: it reloads what it needs from the window. Stack
references in the compiled `bench` went from 187 to 10, its length from 1284 to 738
instructions. Three more changes came out of the same listing:

4. A literal's shape is stored once, before the next guard, call or end of the run, instead of
   once per member.
5. A literal needs no barrier while it is as dirty as it was born. When the allocator is
   called, the literals made earlier in the run are marked again, so they stay that way.
6. The bytecode compiler emits no TDZ check for a read or a write of a local it has already
   initialized on every path that reaches the instruction (`docs/INTERPRETER.md`, "TDZ
   checks"). A `switch` clause, a closure and a loop's back edge keep theirs. The interpreter
   gains the same.

Samples, warmups, source hashes and the compilation proof of the last run are in
[`shape-and-tdz.json`](shape-and-tdz.json); its metadata names `5bfaff0b` with a dirty tree,
which is the content of the commits that follow it here.

| Kernel  |  V8 us | V8 IQR        | Stator us | Stator IQR    | Stator / V8 |
| ------- | -----: | ------------- | --------: | ------------- | ----------: |
| numeric | 22.075 | 22.040-22.132 |    16.513 | 16.501-16.530 |        0.75 |
| objects |  4.201 | 4.201-4.232   |    16.524 | 16.510-16.593 |        3.93 |
| cycles  |  5.445 | 5.433-5.460   |     9.996 | 9.958-10.018  |        1.84 |

Numeric holds: Stator's slowest process (16.756 us) is faster than V8's fastest (22.021 us).
Stator's collections in the instrumented runs: 3088 on cycles with a mean pause of 23.1 us,
1123 on objects with 130.2 us. The load average was between 6 and 7 throughout.

Where the cycle kernel stands (`sample` against the compiled function's addresses): generated
code is 88% of the samples and the collection 3%. An iteration is about 200 instructions and
43 cycles against V8's 22. What is left in it: two allocations of about 55 instructions each,
16 of them the start bit; about 20 stores of results to the frame window that no guard reads;
the `uninit; store` pair of every `let` at the scope's entry and the guard each fused local
operation takes for it; a number check of four instructions per operand. Steps 20 to 22 in
`task.md` follow from that. The objects kernel did not move with the last three changes: its
time is the loop that reads the array back, where every element is asked for its shape, and
its collections.

Checks on that tree, each step of `pnpm run ci` on its own as before: `check-node`,
`check-js-sources`, `typecheck`, `oxlint --deny-warnings .`, `dupes` (0 clones), `zig fmt
--check` and `pnpm run runtime` exit 0; `pnpm run test` 855 passed in 68 files; `test:runtime`
exits 0; `test:subset` 1010 passed, 31 expected-fail, 0 failed; `test:golden` 547 passed;
`test:selfhost`, `test:builtins`, `test:node-coverage` and `test:leak` exit 0; `test:asan` 547
passed; `pnpm run interp:test` exits 0; `pnpm run engine:test` reports `engine: 100 passed, 0
failed`, the new `literals.ts` among them in both modes and under `JSRT_GC_STRESS`.

The Check still fails on objects and cycles, so the card stays open.

## Values out of the window, slots written once, blocks indexed when asked (2026-11-16)

Steps 16 and 21 of `task.md`. Each row of the first table is the median of five interleaved
processes per engine.

| Change                | Record                                                     | cycles us | objects us | numeric us |
| --------------------- | ---------------------------------------------------------- | --------: | ---------: | ---------: |
| before                | [`shape-and-tdz.json`](shape-and-tdz.json)                 |     9.996 |     16.524 |     16.513 |
| the three steps below | [`lazy-stores-and-index.json`](lazy-stores-and-index.json) |     7.097 |     15.089 |     13.420 |

1. **A value stays out of the frame window until something can read it there** (`46c9960d`).
   A result stays in its register and is stored before an instruction that can leave the
   chain, before a call and at the end of the run. The allocator's call and the remainder's
   division, which rarely run, store what waits at their own head, so the path that skips them
   stores nothing for them. In debug builds every guard and call asserts that nothing waits.
   One process per engine after this step alone: cycles 8.212 us, objects 15.489, numeric
   13.650.
2. **A literal's slot is written once.** The allocation no longer zeroes the slots: a member
   fills its slot, and only a slot no member has filled is zeroed, where the chain can first be
   left. The cycle loop was 173 instructions and 37 stores an iteration after this step.
3. **Block starts found, not marked** (step 21). The compiled allocation moves the run's
   pointer and writes the block's two prefix words; it does not read or write the young
   region's index. The run is taken from its top down, so its pointer is the newest block. The
   collector indexes a block when it is first asked about it or about an older block of the
   same run, walking the prefixes up from the nearest block below that the index already has
   (`indexUpTo`); the allocator's own blocks are indexed as they are made and serve as such
   starting points. While another thread may allocate the run reads as full, nothing waits,
   and no reader writes the index.

Three ways of doing 3 were measured and dropped, one process per engine each:

- Indexing a whole run when it closes, walking up from its start: cycles went from 8.2 to
  11.8 us, twice. The walk reads the prefix of every dead block, each read waiting for the one
  before it.
- Indexing from the newest block up to the one asked about: cycles 7.13 us, but objects went
  from 15.5 to 17.3. `sample` had the walk at 158 of about 1300 samples. An array that lived
  through a collection is dirty at the next one, its oldest young elements are counted then,
  and they lie above everything the run made since, all of it dead and all of it walked.
- The same with the walk stepping by the size it saw last, so that the reads overlap: objects
  16.8 us. The step is kept, for the walks that remain.

With the walk started at the nearest indexed block the objects kernel measured 15.1 us and
cycles 7.10.

| Kernel  |  V8 us | V8 IQR        | Stator us | Stator IQR    | Stator / V8 |
| ------- | -----: | ------------- | --------: | ------------- | ----------: |
| numeric | 22.023 | 22.015-22.028 |    13.420 | 13.405-13.468 |        0.61 |
| objects |  4.211 | 4.203-4.212   |    15.089 | 15.060-15.116 |        3.58 |
| cycles  |  5.441 | 5.440-5.446   |     7.097 | 7.092-7.098   |        1.30 |

Numeric holds: Stator's slowest process (13.509 us) is faster than V8's fastest (22.000 us).
On cycles and objects V8's slowest process (5.450 and 4.219 us) is faster than Stator's fastest
(7.081 and 14.994). Stator's collections in the instrumented runs: 4317 on cycles with a mean
pause of 27.8 us, 1158 on objects with 141.2 us. The load average was between 5.2 and 5.7. The
record's metadata names `46c9960d` with a dirty tree, which is the content of the commits that
follow it here.

What the cycle loop still pays for, from the listing after step 2: a value that waits is
stored before each guard it passes; an operand copied from a local is checked as if nothing
were known of it, and the local again after it; each literal makes the run's address, its
prefix words, its class, shape and tags again; and the object is eleven words. Steps 24 to 26
in `task.md` follow from that, with 19 and 22. The objects kernel is still its read loop and
its collections (23).

Checks on that tree, each step of `pnpm run ci` on its own as before: `check-node`,
`check-js-sources`, `typecheck`, `oxlint --deny-warnings .`, `dupes` (0 clones), `zig fmt
--check` and `pnpm run runtime` exit 0; `pnpm run test` 855 passed in 68 files; `test:runtime`
exits 0; `test:subset` 1010 passed, 31 expected-fail, 0 failed; `test:golden` 547 passed;
`test:selfhost`, `test:builtins`, `test:node-coverage` and `test:leak` exit 0 (10M objects peak
at 10560 KB, 2M garbage cycles at 15440 KB, both on a plateau); `test:asan` 547 passed; `pnpm
run interp:test` exits 0, with the six cases of "a value that waits for the frame window is
there when the chain is left"; `pnpm run engine:test` reports `engine: 100 passed, 0 failed`.

The Check still fails on objects and cycles, so the card stays open.

## Reads on the chain, a guard's stores where it fails, fewer cycle candidates (2026-11-16)

Step 24 of `task.md`, the first part of 23 and three changes to the collector. Each row of the
first table is the median of five interleaved processes per engine.

| Change                | Record                                                     | cycles us | objects us | numeric us |
| --------------------- | ---------------------------------------------------------- | --------: | ---------: | ---------: |
| before                | [`lazy-stores-and-index.json`](lazy-stores-and-index.json) |     7.097 |     15.089 |     13.420 |
| the five steps below  | [`reads-and-candidates.json`](reads-and-candidates.json)   |     6.648 |     10.167 |     13.473 |

1. **Reads on the chain.** `obj.key` through the site's inline cache, `array[index]` and
   `i < array.length` have forms on the fast chain: guards for the kind of value, the cached
   shape, an accessor pair, an integer index below the length and a hole, and a load. None
   writes the heap or calls, so a loop of them carries its numeric locals in registers. One
   process after this step alone: objects 10.86 us.
2. **A guard's stores on the path that fails** (step 24). A guard no longer stores what waits
   for the window before it. What it owes, at most eight stores, is written in a block of its
   own after the run, which only the failing guard runs; calls, jumps and the run's end store
   as before. One process after this step: objects 10.7 us, cycles 6.9.
3. **The alternate signal stack is allocated.** It was 128 KiB of static data, which the
   collector read for roots at each collection: the median pause on cycles went from 27 us to
   21.5.
4. **A reference that stayed is not counted again.** `reconcile` counted every reference of a
   dirty object and then released every one it had logged, and a release that leaves a count
   above 0 makes its object a cycle candidate. An instrumented run counted 175 such candidates
   a collection on cycles (133 closures and 22 environments the globals hold, each time) and
   about 1000 on objects (the elements of the array being filled), and trial deletion walked
   602 and 3587 objects for them. `recount` skips the ends of the two lists that match.
5. **A candidate a root names is not walked.** It is alive with all it reaches; it is made
   black before trial deletion, which drops it, and is a candidate again when unpinned.

After 4 and 5 the median pause is 14.0 us on cycles (4605 collections in the instrumented
runs) and 98.0 us on objects (1731), from 27.8 and 141.2.

| Kernel  |  V8 us | V8 IQR        | Stator us | Stator IQR    | Stator / V8 |
| ------- | -----: | ------------- | --------: | ------------- | ----------: |
| numeric | 22.078 | 22.069-22.081 |    13.473 | 13.455-13.474 |        0.61 |
| objects |  4.185 | 4.185-4.188   |    10.167 | 10.119-10.170 |        2.43 |
| cycles  |  5.437 | 5.418-5.450   |     6.648 | 6.645-6.649   |        1.22 |

Numeric holds: Stator's slowest process (13.489 us) is faster than V8's fastest (22.002 us).
On cycles and objects V8's slowest process (5.589 and 4.399 us) is faster than Stator's fastest
(6.635 and 10.116). The load average was between 3.4 and 4.2. The record's metadata names
`dc4b5bc1` with a dirty tree, which is the content of the commits that follow it here.

What is left, from the listings after step 2. The read loop of objects is about 118
instructions an element: the array's kind and length are read twice, the index is converted
and checked in nine instructions, each of the two properties loads the cache's shape and slot
through a three-instruction address, and three results are stored at the loop's end. Its
filling loop is about 130 instructions and two calls an element, and 7% of the samples are the
array's growth. The cycle loop is about 120 instructions an iteration: a value that was read
goes to a float register through the window, a value and its copy are guarded separately, and
eight constants of three instructions are made again. Of a collection on objects, most is the
array a root held when the collection before it ran: all it holds is promoted and then freed
(step 30). Steps 25 to 30 in `task.md` follow from that, with 19 and 22.

The new corpus script `reads.ts` covers each read and each way it leaves the chain (other
shapes, getters, inherited and missing members, holes, indexes that are no element's, strings,
a getter that shortens the array being read, values still in registers when a read leaves).
Mutants were run against it: no stores on a failing guard's path, no accessor guard, no hole
guard and no exactness guard for the index each change its output; the bounds test off by one
does not, because the hole guard answers for the element past the end.

Checks on that tree, each step of `pnpm run ci` on its own as before: `check-node`,
`check-js-sources`, `typecheck`, `oxlint --deny-warnings .`, `dupes` (0 clones), `zig fmt
--check` and `pnpm run runtime` exit 0; `oxfmt --check` passes on the two new files; `pnpm run
test` 855 passed in 68 files; `test:runtime` exits 0; `test:subset` 1010 passed, 31
expected-fail, 0 failed; `test:golden` 547 passed; `test:selfhost`, `test:builtins`,
`test:node-coverage` and `test:leak` exit 0 (10M objects peak at 10400 KB, 10M FFI strings at
10480 KB, 2M computed-key reads at 10464 KB, 2M garbage cycles at 15408 KB, all four on a
plateau); `test:asan` 547 passed; `pnpm run interp:test` exits 0; `pnpm run engine:test`
reports `engine: 108 passed, 0 failed`, `reads.ts` among them in both modes and under the
collector's stress and verify runs.

The Check still fails on objects and cycles, so the card stays open.

## Loops that make literals (2026-11-16)

Steps 22 and 26 of `task.md` and the part of 25 that loads a double from the slot it was read
from, with two changes the listings asked for on the way. A row of five processes in the first
table is the median of five interleaved processes per engine; the others are one process.

| Change                                                            | Processes | cycles us | objects us | numeric us |
| ----------------------------------------------------------------- | --------: | --------: | ---------: | ---------: |
| before ([`reads-and-candidates.json`](reads-and-candidates.json)) |         5 |     6.648 |     10.167 |     13.473 |
| step 1                                                            |         1 |     6.164 |     10.202 |     13.472 |
| steps 1 and 2                                                     |         1 |     5.616 |      9.862 |     15.847 |
| steps 1 to 3                                                      |         1 |     5.574 |      9.798 |     13.454 |
| steps 1 to 6                                                      |         1 |     5.086 |      9.768 |     13.530 |
| steps 1 to 6 ([`literals-in-loops.json`](literals-in-loops.json)) |         5 |     5.084 |      9.704 |     13.359 |

1. **Carried locals in loops with literals.** A literal's instructions have forms on the chain
   only while the chain follows the object, which no table of opcodes can say, so
   `carriedLoops` lowers a loop that holds them into a function it throws away and takes the
   loop when every instruction had a form (`takenWhole`). The compiled allocation no longer
   calls: a run with no room is a guard that fails, and the generic copy of `new_object` calls
   the allocator. With no call on the chain, the bookkeeping that told a literal born before
   the allocator's call from one born after it is gone, and so is the write barrier the chain
   tested for a store into the former.
2. **Constants kept, and carried locals stored on the way out.** A constant that takes more
   than one instruction to make is made once, in the loop's window entries, and kept in a
   register while the register copy of the loop runs, eight of each kind at most (`pooled`).
   A jump inside the loop stores no carried local; a jump out of it goes through a block that
   does (`edge`), and a guard may owe sixteen stores, from eight. Numeric lost 2.4 us to this:
   with the stores gone, its loop was three taken branches an iteration.
3. **A loop's rare blocks after it.** The window entries and the dividing arm of a remainder
   were written in the middle of the loop, and each iteration jumped over them. They are laid
   out after the loop's other blocks (`seldom`), which leaves the numeric loop one taken
   branch. Laying the blocks of failing guards out there as well changed nothing measurable
   and is not in.
4. **One move of the run for literals in a row** (step 22). The first literal of a stretch
   with no guard in it tests the run and moves its pointer for all of them, 256 bytes at most;
   each later one adds its size to the constants of that test (`place`). The cycle loop loads
   and stores the run's pointer once an iteration, where the second literal's load waited for
   the first one's store.
5. **A 16-byte store.** `frozen` and the prototype, which are next to each other and always
   empty in a literal, take one vector store of zero.
6. **The slot a value came from** (part of step 25). A double read from a local was moved to a
   float register through the operand slot it was copied to, which first had to be written.
   The value remembers the local's slot, and is loaded from there while the slot still holds
   it (`atHome`).

The cycle loop makes about 25 stores an iteration, from 29.

| Kernel  |  V8 us | V8 IQR        | Stator us | Stator IQR    | Stator / V8 |
| ------- | -----: | ------------- | --------: | ------------- | ----------: |
| numeric | 21.906 | 21.891-21.978 |    13.359 | 13.316-13.366 |        0.61 |
| objects |  4.140 | 4.133-4.141   |     9.704 | 9.677-9.724   |        2.34 |
| cycles  |  5.451 | 5.445-5.451   |     5.084 | 5.083-5.101   |        0.93 |

Numeric and cycles hold: Stator's slowest process (14.018 and 5.286 us) is faster than V8's
fastest (21.870 and 5.420 us). On objects V8's slowest process (4.142 us) is faster than
Stator's fastest (9.638). The collector ran 5961 times in the instrumented cycles run, 14.3 us
a collection on average, and 1808 times on objects, 97.1 us. The load average was between 4.2
and 5.1. The record's metadata names `21872f78` with a dirty tree, which is the content of the
commits that follow it here.

`literals.ts` has new cases for each step: a loop of literals left by `break` and by its
condition with numbers in registers, a guard between two literals of a stretch, five literals
in a row, a number that reaches a float register from a local's slot and one whose slot has
been written since, and literals taken from memory that other objects left dirty. Mutants were
run against the corpus, and each changes its output or crashes it: a stretch that ignores the
guards and blocks between its literals, a way out of a loop that stores no carried local, a
stretch whose test is not grown by its later literals, no store of zero to `frozen` and the
prototype, and a value loaded from its slot after the slot was written. The last two were
caught only once the cases were known to be compiled: `STATOR_JIT_TRACE=1` showed that a
function with a template literal or a computed string key is left to the interpreter whole,
and the first versions of two cases had one (`ideas.md`).

Checks on that tree, each step of `pnpm run ci` on its own as before: `check-node`,
`check-js-sources`, `typecheck`, `oxlint --deny-warnings .`, `dupes` (0 clones), `zig fmt
--check` and `pnpm run runtime` exit 0; `oxfmt --check` passes on the two changed files it
covers; `pnpm run test` 855 passed in 68 files; `test:runtime` exits 0; `test:subset` 1010
passed, 31 expected-fail, 0 failed; `test:golden` 547 passed; `test:selfhost`, `test:builtins`,
`test:node-coverage` and `test:leak` exit 0 (10M objects peak at 10416 KB, 10M FFI strings at
10496 KB, 2M computed-key reads at 10496 KB, 2M garbage cycles at 15344 KB, all four on a
plateau); `test:asan` 547 passed; `pnpm run interp:test` exits 0; `pnpm run engine:test`
reports `engine: 108 passed, 0 failed`, in both modes and under the collector's stress and
verify runs.

The Check passes on numeric and cycles and still fails on objects, so the card stays open.
