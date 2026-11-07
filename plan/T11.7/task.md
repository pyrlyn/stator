---
status: in progress
priority: P1
complexity: 3
readiness: 30%
agent: Claude Code / claude-opus-5-5
---

# T11.7. Node's own test suite, synced and run through vitest

Creator's direction (2026-10-02, plan-notes 305). The `node:*` wrappers are proven by Node's own
tests, synced at the pinned version, not by hand-written copies.

1. **Sync, don't copy.** `packages/tests/node-suite/pin.json` pins the tag matching
   `.node-version` (v26.7.0). A strict-TS fetch script downloads the selected
   `test/parallel/test-*.js` files and the `test/fixtures` they read. The corpus is fetched, not
   vendored (gitignored), the same way Test262 is (Task 6.1). A Node bump re-pins it, and the diff
   of results is the review.
2. **Selection.** A checked-in expectations file lists each selected test as `pass`, `fail` or
   `skip` with a reason. At v26.7.0, `test/parallel` has 4 641 `test-*` files, and 615 of them
   have a name starting with an N1 module (`fs`, `path`, `os`, `buffer`, `process`,
   `crypto-hash`, `timers`, `perf-hooks`). Start with `path`, then follow T11.6's order. Tests that
   need `// Flags: --expose-internals`, child processes or the network are `skip` until N2.
3. **The harness, in strict TS.** `require('../common')` resolves to
   `packages/tests/node-suite/common/index.ts` (and `../common/fixtures` to
   `common/fixtures.ts`), a strict-TS implementation of the `common` helpers the
   selected tests use (`mustCall`, `mustNotCall`, `expectsError`, `tmpdir`, platform flags). It
   grows with the selection. `node:assert` (`ok`, `strictEqual`, `deepStrictEqual`, `throws`,
   `rejects`) lands in `packages/node` as part of this card.
4. **vitest drives it.** The runner generates one vitest test per selected file. Each test builds
   the file with `--mode=js --node`, runs the binary, and passes on exit 0. The same file must also
   pass under the pinned Node, so a test that fails on the host is `skip`, never `fail`.
5. **Ratchet and coverage.** A `pass` that starts failing fails the run. A `fail` that starts
   passing must be flipped in the same change, as Test262's ratchet does. `docs/NODE.md` gains a
   "node tests" column with passes over the selected count per module.

Depends on T11.5 (`--node`, CommonJS through the T12 bundler) and T11.6. The harness and `path`
can land as soon as `node:path` exists.

**Check:** `pnpm run test:node-suite` runs the selection through vitest against the pinned corpus,
and its pass count is recorded in plan-notes; `docs/NODE.md` shows the column; a hand-flipped
expectation fails the run.

**First slice landed** (plan-notes 314): the
pin, `fetch.ts`, `expectations.json`, the strict-TS `common/` with its host resolve hook, the
vitest driver with the ratchet, `node:assert` in `packages/node`, and the "Node tests" column in
`docs/NODE.md`. The selection is the 17 `test-path*` files: on the pinned Node all 17 pass with
our `common`; under Stator 0 pass, 15 are `fail` and 2 are `skip` (a child process; a
Windows-only file). Every `fail` is a CommonJS file, which goes to the T12 bundler.
**Second slice landed** (plan-notes 318): the Stator build resolves `require('../common')`, since
`fetch.ts` links the corpus's `test/common` to the strict-TS `common/`. The harness no longer
imports `node:util` (N2); `common/inspect.ts` prints what its messages compare. Every `fail` now
stops at `node:process` (the harness's `process.platform`, `exit`, `on` and `cwd`), then
at Rolldown's `__commonJSMin` (STA4013, T12.3), and 13 of them at `path.win32`. **Third slice landed** (plan-notes 403): an untyped read or write
of a class accessor runs the class's `get`/`set` half, which the harness's `common` needed; two
`path` files pass (2 / 17). Every remaining `fail` reason names where the file stops first.
**Next:** `path.win32` (8 files stop there or after the CommonJS helpers), the helpers'
`Object.defineProperty` (T12.3 over T11.4), then T11.6's module order.

Execution plan: per slice, fix what the first stopping point needs at its own layer (runtime,
lowering or `packages/node`), with a golden for it; run `pnpm run test:node-suite`, flip every
file that passes and refresh the reasons of the rest; regenerate `docs/NODE.md`; `pnpm run ci`.
