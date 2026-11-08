---
status: todo
priority: P2
complexity: 4
readiness: 5%
agent:
---

# T67.5. ECMAScript conformance matrix: Test262 by feature and edition for the engine and `js` mode

The creator's direction (2026-11-08): tests that show how much of the ECMAScript standard each
JavaScript engine in Stator supports. Today the numbers exist only as raw Test262 tallies: the
compiler's `pnpm run test262` (a single passed/failed/skipped ratchet, `--mode=js`) and the
engine's `test262:interp-exec` (per directory of `test/language/`, `interp` mode only). Nobody can
read from them "which ES2020 features work under `stator-engine --mode=jit`".

Three columns, one corpus (the pin in `packages/tests/test262/pin.json`):

- `stator-engine --mode=interp`
- `stator-engine --mode=jit`
- the compiler, `statorc build --mode=js`

Rows are Test262 feature tags (the `features:` front matter), grouped by the ECMAScript edition
that shipped them (ES5 … ES2025, plus "untagged" for tests with no feature tag). Scope is
`test/language/` and `test/built-ins/`; `annexB/` is its own group; `intl402/` (ECMA-402) and
`staging/` stay out.

Blocked on T67: `packages/engine` and `stator-engine` are not on `main` yet. Work starts after
T67's branch merges. The heading in `plan.md` §11f next to T67.1–T67.4 lands with the first code
change, not with this card, so this card does not conflict with T67's branch.

Done means:

1. A committed feature → edition table, every edition cited to its primary source
   (tc39/proposals `finished-proposals.md` for ES2016+, ECMA-262 6th edition for ES2015), checked
   against the pinned corpus's `features.txt`: a tag missing from the table fails the run.
2. Both drivers record per-test results with their feature tags: the compiler's runner already
   does; the engine's exec driver gains `test/built-ins/` and a `--mode=jit` run.
3. `docs/ECMASCRIPT.md` is generated from those results (like `docs/NODE.md`): % per edition and
   per feature for each column, and the gaps a column has that another does not.
4. Per-column, per-feature pass counts are ratcheted: a drop fails, a gain is recorded.

Check: `pnpm run docs:ecmascript` regenerates `docs/ECMASCRIPT.md` without a diff, and the ratchet
passes for all three columns.

## Execution plan

1. **Edition table** — `packages/tests/test262/editions.json`: `{ "<feature tag>": "ES2015" | … }`
   plus a `sources` block with the URL and the commit or date checked. Script check: every tag in
   the pinned `features.txt` maps to an edition or to `proposal` (not yet in a published edition).
2. **Result shape** — one shared record per test (`path`, `features`, `verdict`) that both drivers
   write; reuse the compiler runner's metadata parser (`run.ts`) rather than a second front-matter
   reader on the TypeScript side; the Zig driver keeps `common.zig`'s.
3. **Engine driver** — `packages/engine/test262/exec.zig`: add `test/built-ins/` and a mode flag
   (`interp` | `jit`); write `results-interp.json` / `results-jit.json` next to the existing
   ratchet.
4. **Report** — `scripts/ecmascript-matrix.ts` (strict TS): reads the three result files and
   `editions.json`, writes `docs/ECMASCRIPT.md` and `packages/tests/test262/matrix.json` (the
   ratchet). `pnpm run docs:ecmascript` and a staleness check like `test:node-coverage`.
5. **Docs** — `docs/README.md` index row, `AGENTS.md` commands, `plan.md` §11f heading,
   `toolchain.md` only if a dependency is added (none planned).
6. **Verify** — full Test262 run for each column; regenerate; rerun to prove the doc and the
   ratchet are stable; `pnpm run ci`.

Open question for the creator before step 6: whether the matrix and its staleness check join
`pnpm run ci` (a full Test262 run per column is slow) or stay a separate job like `test262`.
