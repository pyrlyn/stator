---
status: in progress
priority: P2
complexity: 3
readiness: 60%
agent: Claude Code / claude-opus-5-5
---

# T75. Bench regression coverage: more programs, a per-program gate, both modes

The creator asked for more regression tests, the benchmark first. `bench:record` (plan.md §9
Task 6.3) times six `ts`-mode programs (fib, nbody, JSON round-trip, string churn, startup,
FFI sqrt) and fails only when the stator geomean grows past 20%, so one program three times
slower can hide inside the mean. Classes and method dispatch, arrays, `Map`/`Set`, closures,
regular expressions, exceptions, typed arrays, promises and `js`-mode dynamic objects are not
timed at all. The bench programs never run in `pnpm run ci`, so a wrong answer surfaces only at
the weekly recording.

Done means:

- New `ts`-mode bench programs cover the hot paths above, each printing a folded result so no
  pass can drop its loop, each byte-identical to the pinned Node.
- `bench:record` also times the `js`-mode programs `engine:bench` already owns
  (`packages/tests/engine/bench/*.js`), built with `--mode=js`; no program is copied.
- One module lists the bench programs and their mode; `bench:record`, `engine:bench` and the
  golden runner read it instead of their own lists.
- `bench:record` fails when any single program regresses past a per-program threshold, on top
  of the unchanged 20% geomean gate. The threshold sits above a spread measured on this host
  and recorded in `plan-notes.md`; a program with no previous result is reported as new.
- The gate's decision is a pure function with unit tests.
- The golden runner runs every bench program against Node, so `pnpm run ci` catches a wrong
  answer the day it lands.

## Execution plan

1. `packages/tests/bench/programs.ts`: `benchPrograms()` → `{ name, path, mode }[]` from
   `bench/programs/*.ts` (no `.d.ts`) and `engine/bench/*.js`.
2. New programs in `bench/programs/`: `classes.ts`, `arrays.ts`, `map-set.ts`, `closures.ts`,
   `regexp.ts`, `exceptions.ts`, `typed-arrays.ts`, `promises.ts`. Each checked: `statorc build`
   succeeds, stdout equals Node's, runtime in the existing 10–300 ms band.
3. `record.ts`: build with the program's mode; extract `regressionFailures(previous, current,
   policy)`; per-program threshold plus an absolute floor so millisecond-scale jitter cannot
   trip it; unit tests in `packages/tests/unit/bench-gate.test.ts`.
4. `engine/bench.ts` and `golden/run.ts` read `benchPrograms()` (golden keys `bench/<name>`;
   the FFI program keeps its extern build).
5. Measure the per-program spread: repeated `bench:record` runs of one commit on this host;
   record the spread and the chosen threshold in `plan-notes.md`; update plan.md §9 Task 6.3
   residue and `docs/` where the bench is described.
6. Gate: `pnpm run ci`.

## Check

`pnpm run test -- bench-gate` passes; `pnpm run test:golden -- --filter=bench/` passes with every
bench program; `pnpm run bench:record` records every program in both modes and its JSON carries
per-program results; `pnpm run engine:bench` runs the shared list; `pnpm run ci` is green.
