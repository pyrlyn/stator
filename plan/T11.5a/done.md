# T11.5a. Closing report

**Phase 11 — T11.5a per-module namespaces ✅ (2026-10-02)**

**Check — PASSED as amended** (the creator moved the test262 clause to T11.4 on 2026-10-02, plan-notes
302; run 2026-10-02, darwin/arm64, Node per `.node-version`,
on main `ede4537`):

- **`std/env` beside a user `get`.** `import { has } from "std/env"; function get(): number {
  return 41; }` builds and prints `42 true`.
- **Same-named private helpers.** Two modules declaring the same private helper build and run as
  under Node: the fixtures `subset_cross_module_collision_{ts,js}`, and the
  `golden/{ts,js}/module_aliasing` goldens.
- **Decision tests.** `node packages/tests/subset/run.ts` →
  `subset: 793 fixtures — 758 passed, 35 expected-fail, 0 failed`.
  - Every aliasing shape is static in both modes: renamed, default and namespace imports; renamed
    exports; `export default <expression>`; `export *`; `export * as`; cross-module collisions.
  - `subset_re_exports_{ts,js}` lost `@expected-fail` in this change.
  - The ambiguous `export *` is `STA3003` in js mode and `STA0012` (TS2308) in ts mode.
- **Goldens.** `node packages/tests/golden/run.ts` → `golden: 408 fixtures — 408 passed, 0 failed`.
  - `golden/ts/module_aliasing` covers renamed imports and exports, default exports,
    `import * as ns`, `export * as` and a re-export chain.
  - `golden/js/module_aliasing` is a mixed js + ts graph. It adds `export *` with an ambiguous
    name and an expression default.
- **`STA1214` is gone for those shapes**, and the self-compilation baseline shrinks with it.
  `node packages/tests/selfhost/run.ts` reported `packages/compiler: STA1214 2572 -> 1771`, and
  `--update` recorded the new count in `packages/tests/selfhost/baseline.json`.
- **test262 `language/module-code` (599 tests): moved to T11.4 by the amendment.** The pass count
  does not rise yet; these numbers are T11.4's baseline.

  | Run | Passed | Skipped | Failed |
  | --- | --- | --- | --- |
  | before | 152 | 351 | 96 |
  | after | 152 | 426 | 21 |

  - The "before" runner compiled module tests away from their fixtures. Its SyntaxError
    passes, the four ambiguous-export tests among them, matched "Cannot find module".
  - The runner now compiles each module test beside its fixtures. The four ambiguous-export tests
    pass on `STA3003`, and no positive module test can pass yet, because the corpus harness itself
    is `STA1214`.
  - Full evidence is in plan-notes 302, "Implementation" and "Check amended". The clause needs the
    harness to compile, which is T11.4's unsupported-globals work.
- **Rest of the gate** (`pnpm run ci`, exit 0).
  - `tsc` (compiler, tests, std), `oxlint --deny-warnings` and `oxfmt --check`: clean.
  - `cpd`: 207 clones, none new against the baseline.
  - vitest: 50 files, 672 tests.
  - `just runtime-test`: the print corpus matches Node.
  - `builtins`: 234/294. `node-coverage --check`: current.
  - leak: plateau.
  - ASan: `node packages/tests/golden/asan-gate.ts` → 408 passed, `golden-asan green`.
