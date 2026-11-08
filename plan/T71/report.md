# T71. V8 comparison and integer remainder in the JIT

Measured on Apple M3 Max, macOS 27.0.1 arm64, Node v26.7.0 / V8
14.6.202.34-node.28, Zig 0.17.1, Stator ReleaseFast. Base commit:
`ec60a284` (T69 plus the merged T67.1 baseline improvements). No dependency changes.

## Measurement

Reused `packages/tests/engine/steady.ts --rounds=3`, `steadyDriver`, `parseSteady`,
`percentile`, `timedRun` and the existing three kernels. The TypeScript kernels are erased
once to identical JavaScript for every engine. Each process warms for at least one second,
then takes fifteen samples lasting at least 100 ms each. Every kernel call is checked;
the standard harness also proves that both `bench` and `checkedBatch` were JIT compiled.
Startup is excluded. These are microbenchmarks, not application-wide speed claims.

[before.json](before.json) and [after.json](after.json) retain the standard harness's raw
samples, source/binary hashes, versions, flags, host load, compilation proof and separate
GC summaries. All throughput samples are retained; unrelated per-event GC traces remain
in the original generated reports under `packages/tests/engine/results/`. An engine CLI build overlapped the last portion of the initial after run;
its objects row is not evidence of a regression. The final comparison below instead
uses [interleaved.json](interleaved.json): three independent processes per binary/kernel,
rotating before → after → V8, after → V8 → before, V8 → before → after. No builds or test
suites ran during that comparison. The exact same generated drivers and the retained
before/after benchmark binaries were used. `parseSteady` checks the checksum and sample
protocol; the generated driver checks each seed-dependent answer.

Microseconds per kernel call, median of per-process medians (lower is better):

| Kernel | V8 | Stator before | Stator after | Time reduction | After / V8 |
| --- | ---: | ---: | ---: | ---: | ---: |
| numeric | 22.252 | 213.642 | 190.008 | 11.06% | 8.54 |
| objects | 4.525 | 238.305 | 237.288 | 0.43% | 52.44 |
| cycles | 5.402 | 176.106 | 173.089 | 1.71% | 32.04 |

Numeric process medians are 212.147–214.889 us before and 188.059–191.987 us after:
the ranges do not overlap. The object result is within variation; no object/GC speedup
is claimed. The small cycles change is not attributed to this optimization. Stator
still loses to warmed V8 on every kernel. Beating V8 remains open work, including T67.1.

## Mechanism and reuse

A two-second macOS [`sample`](numeric-before.sample.txt) of the baseline numeric driver found 285 top-of-stack hits in
`vm.binary`, 199 in `jit.helpers.binary` and 72 in `vm.jsMod`. The baseline emits a general
VM helper call for every `%`, even on the numeric loop's exact integers.

`jit/lower.zig` now expresses the existing `vm.jsMod` integer case through pyrlyn/jit's
existing `cvt`, `fcmp` and `srem` IR. No second remainder algorithm or dependency is added.
Magnitude guards reject boxed values, nonfinite values and numbers at or above `2^53`
before conversion; round trips reject fractions. A nonzero divisor and those bounds
exclude integer traps. Zero results recover the dividend's sign. Every other input
uses the unchanged VM helper, including coercion and exception propagation.

The existing `jitCost` helper counts prove zero general binary calls for 1002 exact
integer remainders and eleven calls for eleven fallback cases. The Node-oracle fixture
checks all 676 pairs of 26 numeric edge values, signed zero via reciprocals, coercion
order and a throwing coercion. Both interpreter and JIT outputs must match Node.

## Cold process measurements

`pnpm run engine:bench -- --runs=3` exited 0 on all 15 programs; every output matched
Node. These are best-of-three wall times including startup, not warmed throughput.
Raw values and peak RSS are in [cold.json](cold.json). No baseline speedup is inferred
from comparisons with older documentation tables.

| program | node (V8) ms | engine jit ms | jit vs V8 | node (V8) MB | engine jit MB |
|---|---:|---:|---:|---:|---:|
| fib.ts | 90.5 | 275 | 3.04x | 80.8 | 11.8 |
| nbody.ts | 58.7 | 25.1 | 0.43x | 83.0 | 12.0 |
| string-churn.ts | 53.8 | 13.3 | 0.25x | 82.3 | 14.7 |
| json-roundtrip.ts | 54.7 | 7.5 | 0.14x | 77.5 | 12.0 |
| hello.ts | 52.0 | 7.1 | 0.14x | 76.6 | 11.6 |
| objects-churn.ts | 80.2 | 851 | 10.61x | 83.6 | 20.7 |
| objects-retained.ts | 108 | 835 | 7.75x | 242 | 315 |
| alloc.js | 43.3 | 500 | 11.54x | 58.6 | 20.7 |
| arrays.js | 54.0 | 318 | 5.89x | 88.4 | 40.5 |
| closures.js | 42.0 | 120 | 2.85x | 56.4 | 11.8 |
| fib.js | 48.6 | 111 | 2.29x | 56.1 | 11.7 |
| loop.js | 57.7 | 325 | 5.63x | 56.8 | 11.7 |
| methods.js | 36.7 | 253 | 6.91x | 56.6 | 11.8 |
| props.js | 45.1 | 254 | 5.62x | 56.7 | 11.9 |
| strings.js | 61.6 | 150 | 2.44x | 120 | 25.8 |

## Reproduce

```sh
mise exec -- pnpm run runtime
mise exec -- node packages/tests/engine/steady.ts --rounds=3
mise exec -- pnpm run engine:bench -- --runs=3
mise exec -- pnpm run interp:test
mise exec -- pnpm run engine:test
mise exec -- pnpm run ci
```

For a base comparison, build `stator-steady` from `ec60a284` and set `STATOR_STEADY` to
that binary when rerunning the unchanged steady harness. Source and binary hashes in
the raw reports identify this sitting's artifacts; fixed warmup does not establish a
stable V8 optimization plateau. Only arm64 macOS was executed; x86-64 remains unverified.
