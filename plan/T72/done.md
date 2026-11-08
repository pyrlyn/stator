# T72. Speed up the full local test run

Delivery: `T72: parallelize full local test runs` on `codex/t72-test-speed`, based on
`ec60a284`. The task's implementation and this report are in the same commit.

Full subset and golden runs now automatically reuse the existing process-sharding runner.
Automatic selection uses at most four processes, bounded by CPU parallelism, the requested
test job count and one process per 2 GiB of total RAM. Workers share the subprocess pool
budget. Explicit shard selectors, filtered runs, impact recording and serial debugging keep
their existing behavior. No fixtures, comparisons, baselines or compiler behavior changed.

Reuse: `fanOutWorkers`, `mergeShardFiles`, `shardSlice` and the existing runner report functions.
The existing job-count parsing is shared through `testJobs`; no dependency was added.
Regression tests cover resource limits, execution-mode selection, ordered complete merges,
missing records and failed workers. Operational documentation and the Phase 6 contract were
updated together; rationale and measurements are recorded under `plan-notes.md` → T72.

## Measurements

Apple M3 Max, 16 logical CPUs, 64 GiB RAM, Node 26.7.0. Single samples on a shared workstation;
these measure complete individual suites, not the whole CI gate.

| Suite | Original execution | Automatic workers | Result |
| --- | ---: | ---: | --- |
| subset | 59.84 s | 13.11 s | 1041 fixtures, 1010 passed, 31 expected-fail, 0 failed |
| golden | 209.88 s | 60.28 s | 525 fixtures, 525 passed, 0 failed |

Subset baseline command: `/usr/bin/time -p node packages/tests/subset/run.ts` at local
main `2232663d`; its compiler, subset and support sources match the task base. An initial
explicit `--shards=4` measurement took 15.88 s with the same report. The implemented default
was measured without flags in this worktree.

Golden comparison in this worktree: `node packages/tests/golden/run.ts --filter=` selects
every fixture while retaining the original in-process path; the same command without the
empty filter selects automatic workers. `cmp` confirmed byte-identical stdout and stderr;
both exited 0. The two optional ICU-only fixtures remain explicitly reported as skipped.
The subset report also matched byte-for-byte.

## Check

`mise exec -- pnpm run ci` exited **0**. Relevant output:

```text
stator: node v26.7.0 matches .node-version (26.7.0)
All matched files use the correct format.
0 clones · 0.0% duplication
Test Files  66 passed (66)
Tests  840 passed (840)
runtime: print corpus matches Node
subset: 1041 fixtures — 1010 passed, 31 expected-fail, 0 failed
golden: 525 fixtures — 525 passed, 0 failed
node-coverage: docs/NODE.md is current
leak: 10M objects — peak RSS 11840 KB of a 65536 KB cap, 54 samples, plateau
leak: 10M FFI strings — peak RSS 12640 KB of a 65536 KB cap, 381 samples, plateau
leak: 2M computed-key reads — peak RSS 13360 KB of a 65536 KB cap, 35 samples, plateau
leak: 2M garbage cycles — peak RSS 15840 KB of a 65536 KB cap, 66 samples, plateau
runtime: print corpus matches Node (ASan/UBSan)
ffi static-lib: ok (asan, two libraries, two collectors collecting on every allocation)
asan: no green record — running the full golden-asan pass
golden: 525 fixtures — 525 passed, 0 failed
asan: golden-asan green — recorded c62d6853d7db…
```

The earlier bare `pnpm run ci` resolved Zig 0.16.0 and failed building stator-ts; using
`mise exec` selected the existing pinned Zig 0.17.1. No tool versions or configuration changed.
The standalone unit run also passed all 840 tests; the TypeScript checker and focused lint
checks passed. `git diff --check` passed.
