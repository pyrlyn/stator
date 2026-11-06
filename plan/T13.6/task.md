---
status: todo
priority: P3
complexity: 3
readiness: 0%
agent:
---

# T13.6. Web-platform-tests for `webapi`, synced and run through vitest

Creator's direction (2026-10-02, plan-notes 305). This is T13.0 §8's DOM oracle, made concrete.
It follows T11.7's design, so the two suites share one fetch, expectation and ratchet mechanism
(Task 6.16: one helper, not two).

1. **Sync.** `packages/tests/wpt/pin.json` pins a web-platform-tests commit, fetched and not
   vendored. Scope is `dom/` (937 files: 651 `.html`, 66 `.any.js`/`.window.js`) and `css/cssom/`
   (352 files: 295 `.html`, 1 `.any.js`), counted at `c5e80ef1dca9`.
2. **Script tests first.** `.any.js` and `.window.js` need no markup and run first. `.html` tests
   need their markup turned into a document. T13.0 decides between an HTML parser in `webapi`
   (which `innerHTML` would also need) and a dev-only pre-pass at fetch time that turns markup into
   DOM-building calls. Until then `.html` tests are `skip`.
3. **The harness, in strict TS.** A strict-TS `testharness` subset (`test`, `promise_test`,
   `async_test`, `assert_*`, `done`) replaces `testharness.js` for the selected tests.
4. **vitest drives it,** with the same per-file ratchet as T11.7. `docs/WEBAPI.md` (T13.5) gains a
   "WPT" column.

Depends on T13.1 and T13.5. Lower priority than T11.7 (Phase 11 first).

**Check:** `pnpm run test:wpt` runs the selection through vitest against the pinned commit, and
its pass count is recorded in plan-notes; `docs/WEBAPI.md` shows the column; a hand-flipped
expectation fails the run.
