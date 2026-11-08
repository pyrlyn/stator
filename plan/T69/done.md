# T69. Warmed JIT comparison and full GC pause tracing — done

Change: the commit containing this report on `codex/t69-warmed-jit-gc`.

- Added a benchmark-only monotonic-clock host, reusing the existing engine, runtime,
  `rt_nanos`, build helper, pinned Node and `timedRun`. No production CLI flag, global,
  dependency, second value model or collector.
- Added three escaping-allocation/numeric kernels and a shared generated JavaScript driver:
  checked inputs/results, in-process warmup, fifteen timed batches, alternating process order,
  raw samples and metadata, and explicit proof that measured functions compiled natively.
- Added disabled-by-default `JSRT_GC_TRACE` around the whole collection. Stator tracing and
  V8 GC observation run separately from throughput. Updated `docs/VALUE.md`, `docs/ENGINE.md`,
  `plan.md`, and plan-notes T69.
- Recorded the baseline in `report.md` and `baseline.json`. All three workloads still lose
  to V8. The creator left T67.1 with its existing owner; that optimization work is untouched.

## Check

All commands below used `mise exec --` for the pinned toolchain and exited 0.

```
$ pnpm run ci
0 clones · 0.0% duplication
Test Files  65 passed (65)
     Tests  832 passed (832)
runtime: print corpus matches Node
subset: 1041 fixtures — 1010 passed, 31 expected-fail, 0 failed
golden: 525 fixtures — 525 passed, 0 failed
selfhost: 22 targets match the baseline
node-coverage: docs/NODE.md is current
leak: 10M objects — peak RSS 12880 KB of a 65536 KB cap, 50 samples, plateau
leak: 10M FFI strings — peak RSS 12672 KB of a 65536 KB cap, 373 samples, plateau
leak: 2M computed-key reads — peak RSS 12336 KB of a 65536 KB cap, 28 samples, plateau
leak: 2M garbage cycles — peak RSS 16224 KB of a 65536 KB cap, 62 samples, plateau
runtime: print corpus matches Node (ASan/UBSan)
ffi static-lib: ok (asan, two libraries, two collectors collecting on every allocation)
golden: 525 fixtures — 525 passed, 0 failed
asan: golden-asan green — recorded 4f7d5c48bb78…

$ pnpm run interp:test
$ zig build test --build-file packages/engine/build.zig
(exit 0)

$ pnpm run engine:test
engine: 54 passed, 0 failed
```

Both golden runs explicitly skipped two `intl_*` fixtures: ICU is outside this gate.
The full gate ran while the harness was being finalized. After its benchmark-only additions,
`pnpm run typecheck`, `pnpm run lint`, `pnpm run dupes`, and the focused benchmark evidence
tests were repeated on the final harness (4 passed, 0 failed). Runtime instrumentation was
unchanged throughout the green full gate.

```
$ node packages/tests/engine/steady.ts --rounds=3
| kernel | V8 us | JIT us | JIT / V8 | Stator GC count | Stator GC p99 ms | V8 GC event p99 ms |
| cycles.ts | 5.427 | 257.918 | 47.53 | 171 | 0.991 | 0.062 |
| numeric.ts | 22.470 | 161.668 | 7.19 | 0 | 0.000 | 0.279 |
| objects.ts | 4.632 | 278.634 | 60.16 | 182 | 1.421 | 0.165 |
```

Allocation kernels triggered measured collections in both engines; every call returned its
Node oracle result. All measured functions compiled. Numeric required no Stator collection.
See `report.md` for the limits of the GC comparison and the still-open performance goal.
