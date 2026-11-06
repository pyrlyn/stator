# T11.2. Closing report

**Phase 11 — T11.2 std package ✅ (2026-10-02)**

**Check — PASSED** (2026-10-02, darwin/arm64, Node per `.node-version`, on main `fde70c0`):

- `std_env` / `std_path` goldens pass through `import … from 'std/…'` with no `declare`
  fixture: the 284 fixtures (`env.d.ts`, `path.d.ts`, `path.c`, both `node_shim.mjs`,
  `helper_std_*.d.ts`) are deleted, and `node packages/tests/golden/run.ts` →
  `golden: 402 fixtures — 402 passed, 0 failed` (std goldens: `std_env`, `std_path`,
  `std_process`, `std_fs`, `std_time`, js `std_js`).
- T10.1's Check (`std/process`, sync `std/fs`, `std/time` with goldens against Node): the same
  run; `node packages/tests/subset/run.ts` → 761 fixtures, 724 passed, 37 expected-fail,
  0 failed (std fixtures in both modes per module, plus `STA3002` unknown and `STA1214`
  thread refusals).
- A program without `std/*` imports links no `libjsrt_std.a`: `unit/std.test.ts` proves the
  link line carries the archive only for a std importer (before `-ljsrt`, the only difference)
  and that the module-graph test is false for a plain program. Vitest → `Tests 607 passed (607)`.
- Rest of the gate: `tsc --noEmit` for compiler, tests and std clean; `oxlint --deny-warnings`
  0 warnings; `oxfmt --check` clean; `cpd .` passes against the baseline (no new clones);
  `golden/builtins.ts` → 223/238 members (94%), exit 0; `node-coverage.ts --check` →
  `docs/NODE.md is current`; `zig fmt --check` clean; runtime `-Werror` build and `just std`
  green; `STATOR_ASAN_FORCE=1 node packages/tests/golden/asan-gate.ts` → print corpus matches Node
  under ASan/UBSan, golden-asan 402 passed, 0 failed.

Design decisions, deviations, the emitter fix and the pre-existing gaps it found: plan-notes 294.

The stub `plan.md` kept when the task closed:

~~**T11.2. `packages/std`: the real `std/*` package.**~~ ✅ **landed 2026-10-02** — evidence above (plan-notes 294).
