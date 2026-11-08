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

| Kernel | V8 us | Stator before us | Stator after us | Time reduction | After / V8 |
| --- | ---: | ---: | ---: | ---: | ---: |
| numeric | 22.431 | 169.918 | 170.309 | -0.23% | 7.59 |
| objects | 4.597 | 249.129 | 234.009 | 6.07% | 50.91 |
| cycles | 5.449 | 172.566 | 156.619 | 9.24% | 28.74 |

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
