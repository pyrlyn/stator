# T75 — done

Branch `t75-bench-regressions`, written on `ec60a284` and rebased onto `674ab4d7`. The card
was drafted as T72 and renumbered: `origin/main` took T72 to T74 in the meantime.

## What was done

- **Eight new `ts`-mode bench programs** in `packages/tests/bench/programs/`: `classes.ts`
  (virtual dispatch over three receiver classes), `arrays.ts` (growth, indexing, map/filter/
  reduce/sort), `map-set.ts`, `closures.ts`, `regexp.ts`, `exceptions.ts` (user class and
  `Error`, `finally`), `typed-arrays.ts` (`Uint8Array` sieve, `subarray`/`set`),
  `promises.ts`. Each prints a folded result and matches the pinned Node.
- **One program list**, `packages/tests/support/bench-programs.ts`: the `ts` set plus the `js`
  set `engine:bench` already owned (`packages/tests/engine/bench/*.js`, no copies).
  `bench:record`, `engine:bench`, `bench:memory`, `bench:profile` and the golden runner read it;
  three hand-written lists are gone.
- **`bench:record` in both modes**: `js` programs build with `--mode=js`; result keys stay
  bare for `ts` and are `js/<name>` for the rest.
- **Per-program gate** (`packages/tests/bench/gate.ts`, pure, 11 unit tests in
  `packages/tests/unit/bench-gate.test.ts`): a program fails past 75% and at least 10 ms of
  growth; the 20% geomean gate now compares only programs both recordings share; a new program
  is reported, not failed.
- **Bench programs are golden fixtures** (`ts/bench/<name>`, `js/bench/<name>`), known to the
  impact selector and the ASan gate's input hash.
- **Reference engines get type-stripped copies**: `qjs` on `PATH` aborted every recording on
  `.ts` input before this change. A program a reference engine cannot run is listed with its
  reason; `engine:bench` shows a ✗ for the engine likewise, never a time.
- Docs: plan.md §9 Task 6.3, `docs/ENGINE.md` §4, `docs/TOOLCHAIN.md`, `AGENTS.md`,
  `packages/tests/bench/memory/README.md`; regenerated `packages/tests/bench/README.md` and
  `baseline.json`. Evidence and the threshold choice: plan-notes 414.

## Finding

`promises.ts` at 600 rounds panics in the collector (`a count fell below zero`), at
`ec60a284` too: carded as plan/T76. The program runs 200 rounds until T76 lands.

## Check

- `pnpm exec vitest run packages/tests/unit/bench-gate.test.ts`: `Tests 11 passed (11)`.
- `node packages/tests/golden/run.ts --filter=/bench/`: 22 fixtures, all pass (before the
  promises round count was set to 200: 21 passed, `promises.ts` failed with the T76 panic).
- Five `bench:record` runs, then a sixth gated against the fifth:
  `bench: recorded 22 programs to …/2026-11-08T20-01-55-383Z-darwin-arm64-….json`.
- `engine:bench --runs=1`: 23 programs; ✗ for the engine on `map-set.ts`, `promises.ts`,
  `typed-arrays.ts`, with reasons.
- `pnpm run ci`: green on every step — `0 clones`, unit `855 passed (855)` after the rebase, subset
  `1041 fixtures — 1010 passed, 31 expected-fail, 0 failed`, `golden: 547 fixtures — 547
  passed, 0 failed`, selfhost `22 targets match the baseline`, `docs/NODE.md is current`,
  leak plateaus, `asan: golden-asan green`. `oxfmt --check` was run over the repository's files:
  the full glob also reaches the harness's untracked, globally ignored
  `.claude/settings.local.json` in the worktree, which is not part of the tree.
