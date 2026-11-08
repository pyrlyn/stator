# T74. Startup and compilation measurements

Base: `149ebde3458e5acb0cd2ac9a00e7f3240385379c`. Apple M3 Max, arm64, macOS 27.0.1
(Darwin 27.0.0), Node 26.7.0 / V8 14.6.202.34-node.28, Zig 0.17.1, ReleaseFast.
The optimizing tier remains T67.1's work. This change improves baseline compilation cost;
it does not establish that Stator is faster than V8 on all three requested axes.

## Evidence and mechanism

The initial instrumented baseline put 35 of 39 ms into backend compilation on 24 functions
with 64 arithmetic/branch pairs each. The accompanying [sample](compile.sample.txt), taken
with macOS `sample` for three seconds on 128 functions of width 256, identifies register
allocation and interval construction as the main compiler cost. The larger sample corpus
is for diagnosis, not the reported before/after table.

The pinned [pyrlyn/jit register allocator](https://github.com/pyrlyn/jit/blob/20d0ed4e4618d6ee040943644f5521db5fb91353/src/core/regalloc.zig)
(`liveOut`, inspected 2026-11-08) scans backwards in physical block order to a fixed point.
Stator creates join blocks before their predecessors. Ordering the finished IR in reverse
postorder allows those forward dependencies to flow through a sweep. Only acyclic reachable
graphs are reordered; a reachable backedge returns before any block or edge is changed. This uses the existing
IR and backend; it adds no allocator, optimizer tier, dependency or JavaScript semantics.
Entry, edges, block arguments, backedges and unreachable blocks survive the permutation.
Traversal uses an explicit stack. Temporary layout storage belongs to the IR's existing arena.

## Method and raw data

[`startup.json`](startup.json) records nine independent rounds per case and rotates the
engine order each round. Both Stator binaries were built with `zig build cli
-Doptimize=ReleaseFast` and the same runtime archive. The before binary contains timing
instrumentation but no layout change; the after binary adds layout. Their SHA-256 hashes
are recorded. No builds or tests from this chat ran during these measurements; the shared
machine was busy (load average about 23), so quartiles and raw samples matter.

`compile-protocol.ts` generates the identical function bodies for each engine, and Node
provides the byte-for-byte answer oracle. Every named function must have exactly one successful
compilation record. The functions contain arithmetic and branches; they are a synthetic
compile-cost corpus, not a representative application suite. The trivial launch fixture prints
one number. Source hashes, exact command lines, stdout/stderr, wall times and peak RSS are saved.

Cold measurements use fresh processes and warm filesystem caches, no tracing, and include
the timing wrapper, parsing, compilation, execution and exit. Compilation totals instead sum
24 functions' instrumented stage durations: analysis, IR construction/layout, backend and
executable-memory publication. They exclude parsing, execution, trace output and cleanup.
The cold measurements independently include cleanup, so that excluded cost cannot explain
away the observed launch improvement.

V8's diagnostic runs force synchronous Sparkplug or TurboFan compilation. TurboFan's feedback
preparation is outside its reported compilation duration. V8 traces round to microseconds;
their boundaries and the quality of generated code differ from Stator's baseline. They are
not apples-to-apples evidence of a superior optimizer or the default V8 tiering policy.

## Results

Medians in milliseconds; brackets contain p25–p75 of the nine runs.

| Case | Before | After | Change |
| --- | ---: | ---: | ---: |
| 24 width-8 functions, compilation | 2.661 [2.656–2.702] | 2.618 [2.554–2.631] | -1.6% |
| 24 width-64 functions, compilation | 40.153 [39.917–40.490] | 31.786 [31.712–31.978] | -20.8% |
| Width-64 cold process | 48.204 [48.080–48.514] | 40.052 [39.703–40.356] | -16.9% |
| Width-8 cold process | 9.475 [9.309–9.566] | 9.385 [9.175–9.438] | no resolved change |
| Trivial cold process | 6.005 [5.859–6.131] | 6.034 [5.710–6.074] | no resolved change |

V8 Sparkplug compilation: 0.200 ms (width 8), 0.974 ms (width 64). TurboFan: 4.934 and
23.942 ms. Stator remains slower than Sparkplug at both sizes and slower than TurboFan at the
larger size. Node's default cold process took 32.507, 33.031 and 35.519 ms for the trivial,
width-8 and width-64 cases respectively. Stator wins the short-process comparison and loses
the larger one. There is no universal speed claim.

Median width-64 cold peak RSS was 25.781 MiB before and 26.203 MiB after (about +1.6%);
it includes the parser, runtime, temporary compilation data and executable pages.

## Final warmed regression check

[`warmed.json`](warmed.json) uses T69's unchanged kernels and exported `steadyDriver`,
`parseSteady`, `percentile` and `timedRun` helpers. Each process warms for at least one second
and records fifteen batches of at least 100 ms, checking every result against Node. Three
rounds rotate V8, before and after; separate trace runs require `bench` and `checkedBatch`
to compile in both Stator binaries. Both hosts use the same runtime archive and ReleaseFast.
The baseline host is built from the base commit without the instrumentation or layout patch.
Binary/source hashes and raw samples are retained. No other builds or tests from this chat
ran during this measurement. Fixed warmup is not proof of a stable V8 tier.

Microseconds per checked call, medians of the three process medians; brackets give their range:

| Kernel | V8 | Before | After |
| --- | ---: | ---: | ---: |
| numeric | 21.698 | 165.248 [164.940–175.161] | 169.620 [165.562–172.906] |
| objects | 4.185 | 223.668 [212.616–227.855] | 223.129 [211.304–224.133] |
| cycles | 5.181 | 166.609 [162.855–167.557] | 167.666 [163.627–167.918] |

The before/after ranges overlap in all three cases. The numeric median is 2.6% higher;
three rounds on a shared machine do not resolve that change. No warmed speedup or formal
equivalence is claimed. The object slowdown of the unrestricted trial is absent. Stator
still loses to V8 on every warmed kernel; the optimizing tier remains necessary.

## Reproduction

```sh
mise exec -- pnpm run runtime
mise exec -- zig build cli -Doptimize=ReleaseFast --build-file packages/engine/build.zig
STATOR_ENGINE_BEFORE=/absolute/path/to/instrumented-before \
  STATOR_ENGINE=/absolute/path/to/after \
  mise exec -- node packages/tests/engine/startup.ts --rounds=9
```

Build the before binary with the timing instrumentation but without importing or calling
`layout.orderAcyclic`. Keep all other source, dependencies and flags equal. No timing
ratio should be inferred by comparing these samples with another machine's results.

For the warmed comparison, build `stator-steady` from the base commit and this change with
`zig build steady -Doptimize=ReleaseFast`, linking the same runtime. The standard
`STATOR_STEADY=/absolute/path/to/host node packages/tests/engine/steady.ts --rounds=3`
uses the same drivers and kernels; alternate the before, after and V8 processes when
collecting paired evidence on a shared machine.

## Rejected unrestricted layout

The first trial also reordered cyclic graphs. Its compilation and launch results are in
[`trial-rpo-startup.json`](trial-rpo-startup.json), and its warmed comparison is in
[`trial-rpo-warmed.json`](trial-rpo-warmed.json). In three rotating rounds the object kernel's
median went from 212.202 to 228.697 microseconds per checked call (+7.8%). Although layout is
semantics-preserving, it changes register intervals and native-code locality. The final change
therefore preserves cyclic graphs' original layout; it does not trade that warmed regression
for faster compilation. Unit coverage checks this no-mutation path as well as diamonds and
block arguments.
