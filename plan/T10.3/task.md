---
status: in progress
priority: P1
complexity: 4
readiness: 100%
agent: Claude Code / claude-opus-5-5
---

# T10.3. Threaded / parallel host compiler

Independent of T10.1/T10.2. Host Node only.

Steps:

1. ✅ **Baseline (2026-10-23, plan-notes 374):** wall time of `stator build` on a fixed multi-file
   fixture at `STATOR_COMPILE_JOBS=1` with spans (frontend / lower / verify / emit / clang / link).
   `STATOR_COMPILE_TIMING=1` prints the span line.
2. ✅ **C1 — parallel clang (2026-10-23, plan-notes 374):** `STATOR_COMPILE_JOBS` partitions the
   emitted C and compiles the units concurrently. **2.11×** on the 556KB fixture (jobs=8 vs 1);
   `STATOR_COMPILE_JOBS=1` keeps byte-identical C. `STA0021` for a bad value. C2 below was not
   taken (emit is 10 ms of a 2.4 s build).
3. C2 — parallel emit if emit shows in the profile. **Not taken** (plan-notes 374: emit 10 ms).
4. C3 — sharded lower/verify via process pool if typecheck/HIR dominate; document the Program
   isolation choice. **Not taken** (plan-notes 374: `hir/verify` 3 ms).
5. ✅ **CI smoke (2026-10-24, plan-notes 381):** one non-required job (`compile jobs smoke`)
   builds the multi-module `tests/golden/ts/modules` fixture and runs
   `packages/tests/unit/compile-jobs.test.ts` with `STATOR_COMPILE_JOBS=2` so races fail the
   build; default CI stays serial for log readability. Required checks keep their names.

**Check:** documented before/after numbers in plan-notes; `STATOR_COMPILE_JOBS=1` preserves
byte-identical emitted C for the fixture; CI green. **Met 2026-10-23** (plan-notes 374) except
the step-5 CI smoke, which **landed 2026-10-24** (plan-notes 381) — CI green on the job itself
is observable after merge.

Execution plan (closing): confirm the `compile jobs smoke` job is green on `main`, rerun
`compile-jobs.test.ts` under `STATOR_COMPILE_JOBS=2` locally, and write `done.md`.
