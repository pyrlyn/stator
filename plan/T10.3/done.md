# T10.3. Done

Steps 1, 2 and 5 landed earlier (plan-notes 374, 381): the baseline and the span timing,
`STATOR_COMPILE_JOBS` parallel clang (2.11× on the 556KB fixture, byte-identical C at
`STATOR_COMPILE_JOBS=1`, `STA0021` for a bad value) and the non-required `compile jobs smoke` CI
job. Steps 3 (C2) and 4 (C3) were not taken: emit is 10 ms and `hir/verify` 3 ms of a 2.4 s build.
What was left was the Check's last clause, CI green on the smoke job after merge.

How it was checked:

- `main` at a1ee0732 (T66, #266), workflow `ci` run 42474750799 is `success`, and its
  `compile jobs smoke` job 128713446078 is `success`, including the step
  `Parallel clang smoke (STATOR_COMPILE_JOBS=2)`:
  https://github.com/pyrlyn/stator/actions/runs/42474750799/job/128713446078
- Caveat: the job's second step, `compile-jobs unit tests under STATOR_COMPILE_JOBS=2`, was
  skipped there, because `SKIP_CI_TESTS` skips test steps in every recent CI run. It was run
  locally on the same commit instead:
  `STATOR_COMPILE_JOBS=2 pnpm exec vitest run --config packages/tests/vitest.config.ts packages/tests/unit/compile-jobs.test.ts`
  gave 1 file, 17 tests passed (macOS arm64).

Branch: `t10.3-close-compile-jobs`.
