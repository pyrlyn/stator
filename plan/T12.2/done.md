# T12.2. Closing report

**Phase 12 — T12.2 `packages/vite-stator` ✅ (2026-10-02)**

**Check evidence.**

- Goldens through the default adapter, byte-for-byte vs Node: `pkg_imports` (named and default
  imports, a package `exports` map) and `pkg_shared_dependency` (`a1 b2 a3` / `4 4`: one
  `counter` instance). `pnpm run test:golden` → `golden: 433 fixtures — 433 passed, 0 failed`;
  `node packages/tests/golden/run.ts --bundler=none --filter pkg_` →
  `golden: SKIPPED 2 fixtures that import packages (--bundler=none)`.
- `examples/vite` builds a binary with `vite build`: unit test `examples/vite: vite build writes
  a binary that prints what Node prints` (`packages/tests/unit/vite-stator.test.ts`, 4 tests).
- Tree-shaking: 1 of 40 functions imported; the vendor module holds only `function f7` (unit
  test `the adapter tree-shakes`); the binary is 116 880 B through the package and 116 880 B with
  the function in the project, 0% apart (plan-notes 321).
- The Node suite (T11.7): `pnpm run test:node-suite` → `Tests  15 passed | 2 skipped (17)`; the
  15 CommonJS `test-path*` files now stop at `STA0015` (`../common` resolves only through the
  harness's host hook), not `STA0014` (plan-notes 321).
- `pnpm run ci` on the branch rebased onto 9a26b03: exit 0 (typecheck, lint, dupes at 188
  clones, runtime, unit `Test Files  55 passed (55)` / `Tests  721 passed (721)`, runtime
  corpus, subset `879 fixtures — 846 passed, 33 expected-fail, 0 failed`, golden 433/433,
  selfhost `12 targets match the baseline`, builtins, node-coverage, leak, ASan golden 433/433).

The stub `plan.md` kept when the task closed:

~~**T12.2. `packages/vite-stator`: the default integration.**~~ ✅ **landed 2026-10-02** — evidence above (plan-notes 321; `docs/BUNDLER.md` §2). Its namespace-import
golden moved to T12.3's Check: Rolldown's `__exportAll` is T12.3's helper item.
