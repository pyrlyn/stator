# T69. Warmed V8 baseline

Measured 2026-11-08 on Apple M3 Max, macOS arm64, Node v26.7.0 / V8
14.6.202.34-node.28, Zig 0.17.1, Stator ReleaseFast. Source base:
`6fc97a20c478aece94ea1a39a36f3cb0934064dd`, with T69's instrumentation and harness.
T67.1's ongoing optimizing-tier work is not in this baseline. Raw samples, hashes, flags,
dirty state and GC events are in [baseline.json](baseline.json).

Command: `mise exec -- node packages/tests/engine/steady.ts --rounds=3` (exit 0).
Three independent processes per engine per kernel, order alternating each round; at least
1000 ms warmup, then fifteen samples of at least 100 ms per process. Each kernel call checks
one of sixteen seed-dependent results. Both kernels and their batch driver are confirmed
JIT-compiled; no silent interpreter fallback is accepted. The exact method and its limitations
are in `docs/ENGINE.md` §4.1.

## Throughput

Microseconds per checked kernel call, median of per-process medians. Lower is better.

| Kernel | V8 | Stator JIT | JIT / V8 | V8 process medians | JIT process medians |
| --- | ---: | ---: | ---: | --- | --- |
| cycles | 5.427 | 257.918 | 47.53 | 5.427, 5.382, 5.428 | 259.206, 256.536, 257.918 |
| numeric | 22.470 | 161.668 | 7.19 | 22.470, 22.555, 22.339 | 160.882, 163.069, 161.668 |
| objects | 4.632 | 278.634 | 60.16 | 4.631, 4.632, 4.661 | 278.634, 274.596, 291.531 |

Stator loses on all three kernels. These are small, named workloads, not a representative
application suite. Numeric uses remainder in its loop. Objects creates and retains an array
of 1000 records; cycles creates 1000 object pairs and publishes them through a global root.
The functions are retained and repeatedly called inside the same process; process startup is
outside the measured intervals. The load averages at the start were 13.71, 14.98, 14.69;
other sessions were active, so this is a baseline with raw variability, not a small-regression
threshold or a quiet-machine performance claim.

## GC observations

Separate instrumented processes, not the throughput runs above. Stator measures full
collection latency; V8 supplies `perf_hooks` GC event durations. Their boundaries differ,
so a percentile ratio is not a collector speedup. Call counts also differ because each
instrumented process runs for a time budget rather than a fixed number of allocations.

| Kernel | Stator collections | Stator p99 ms | V8 event p99 ms | Stator total ms | Stator measured calls | Stator ns / call | V8 event ns / call |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cycles | 171 | 0.991 | 0.062 | 147.213 | 6000 | 24535.5 | 1072.9 |
| numeric | 0 | 0 | 0.279 | 0 | 9424 | 0 | 4.1 |
| objects | 182 | 1.421 | 0.165 | 170.238 | 5584 | 30486.7 | 185.5 |

Numeric's V8 events can include harness allocations; zero Stator collections is not a general
claim of zero memory-management cost. The traced Stator batches take at least 1500 ms, so
full collections account for at most 9.8% (cycles) and 11.4% (objects) of that measured-phase
time. Allocation, indexing and write-barrier costs occur outside these pauses and remain
unattributed. Removing pauses alone cannot explain away the much larger throughput gaps.

## Next measurements

- Re-run this unchanged corpus on T67.1 once its owner finishes it, keeping source hashes,
  flags and hardware comparable. Do not replace the losing rows with easier kernels.
- Profile allocation, shape transitions, helper calls and generated-code memory traffic
  separately from collection pauses before choosing a GC replacement or JIT optimization.
- Extend coverage beyond the three kernels, explicitly tracking unsupported opcodes and
  checking for a stable performance plateau rather than relying only on fixed warmup.

The goal of beating warmed V8 remains open. T69 establishes the comparison and telemetry;
it makes no runtime-speedup claim.
