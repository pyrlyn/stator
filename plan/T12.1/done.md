# T12.1. Closing report

**Phase 12 — T12.1 bundler API ✅ (2026-10-02)**

**Check evidence.**

- Unit tests over stub adapters, `packages/tests/unit/bundler.test.ts` (16 tests): the vendor
  entry and mangling, the rewrite, CommonJS routing, `compile` with a stub (C carries
  `#line 3 "<root>/node_modules/leftpad/index.js"`), a vendor diagnostic at
  `node_modules/leftpad/index.js:6:1 STA1214`, a helper diagnostic at `<package bundle>` with
  "(bundler runtime helper, no source mapping)", STA0014 with no `vite-stator` installed and for
  a missing or export-less module, STA0015 for a rejecting adapter and a map-less bundle, an
  adapter that is never called when nothing needs bundling, STA0004, and the cache key.
  `pnpm run test` → `Test Files  52 passed (52)`, `Tests  704 passed (704)`.
- `js` goldens with Vite not installed (`node_modules/vite`, `node_modules/vite-stator` absent):
  `pnpm run test:golden` → `golden: 415 fixtures — 415 passed, 0 failed`;
  `node packages/tests/golden/run.ts --bundler=none` → `golden: 415 fixtures — 415 passed, 0 failed`.
  The default run is the proof that no adapter loads: a fixture that needed one would fail STA0014.
- Decision tests `subset_node_{filename,dirname}_{ts,js}` (not-yet, STA1218):
  `pnpm run test:subset` → `subset: 825 fixtures — 790 passed, 35 expected-fail, 0 failed`.
- Self-compilation: the new code adds 1 × STA1207 (the adapter's `import()` of a computed
  specifier) and 63 × STA1214 to `packages/compiler` (1648 → 1711), recorded with `--update` (plan-notes 306);
  `pnpm run test:selfhost` → `selfhost: 10 targets match the baseline`.
- `pnpm run ci` on the branch rebased onto 10930d1: exit 0 (typecheck, lint, dupes at 205 clones,
  runtime, unit, runtime corpus, subset, golden, selfhost, builtins, node-coverage, leak, ASan).

The stub `plan.md` kept when the task closed:

~~**T12.1. `packages/compiler`: the bundler API.**~~ ✅ **landed 2026-10-02** — evidence above (plan-notes 320; `docs/BUNDLER.md`). Still open from the card,
each `STA1214`: `export * from 'p'` (only the bundler knows the names), `import('p')` and a package
import with import attributes are not rewritten to the vendor module. T12.3 owns them (plan-notes
320 Q3); its first slice landed `export *` from one package and the attributes (plan-notes 323).
