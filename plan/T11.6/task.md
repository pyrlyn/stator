---
status: in progress
priority: P1
complexity: 4
readiness: 80%
agent: Claude Code / opus-5-5
---

# T11.6. `packages/node`: the N1 wrappers

Depends on T11.1, T11.3, T11.5, T11.5a. Create `packages/node` (strict TS over `std`, written from
scratch). Surface, from the corpus (`docs/NODE.md` **tsc** column): `node:fs` sync subset (the 15
functions `tsc` calls), `node:path` (posix), `node:os`, `node:perf_hooks.performance`,
`crypto.createHash`, `process` (`argv`/`env`/`cwd`/`exit`/`exitCode`/`platform`/`pid`/
`stdout.write`/`memoryUsage`/`nextTick`), `Buffer.from`/`toString`, timers. Without a loop (N2),
timers are `std/thread.runOnMain` macrotasks in libuv's phase order, and the main thread sleeps
until the earliest one is due (plan-notes 394).
Every member lands with a golden and a `node_coverage.json` claim; `docs/NODE.md` regenerates in
the same change.

**First slice landed** (plan-notes 313):
`packages/node` exists (workspace package, moon project, selfhost target with a `node-goldens`
smoke, `stator.config.json` with `"node": true`), and `node:path` plus `node:path/posix` are
POSIX-complete: 14 of 16 members each, every one with a golden and a claim. A golden fixture
named `node_*` builds with `--node`. Not landed: `path.win32` and `node:path/win32` (Windows
semantics, outside N1) and `path.matchesGlob` (Node's glob matcher; nothing in the corpus uses
it). **Second slice landed** (plan-notes 317): the `node:fs` sync subset, 12 of the 15
functions `tsc` calls (`closeSync`, `existsSync`, `mkdirSync`, `openSync`, `readFileSync`,
`readdirSync`, `realpathSync`, `statSync`, `unlinkSync`, `utimesSync`, `writeFileSync`,
`writeSync`) plus `rmdirSync`, with Node's `SystemError` shape. `watch`, `watchFile` and
`unwatchFile` wait on the event loop (N2) and stay `STA1214`. **`process` slice landed
2026-10-23** (plan-notes 374): `packages/node/src/process.ts` answers `argv`, `env` (startup
snapshot via new `std/env.names()`), `cwd`, `exit`, `exitCode`, `pid`, `ppid`, `platform`,
`arch`, `execPath`, `hrtime()` and `memoryUsage()` (rss), with goldens `ts/node_process.ts` and
`js/node_process.js`, three decision tests, and `docs/NODE.md` at 12/68 for `node:process`.
**Follow-up slice** (plan-notes 390, #168): `argv0`, `execArgv`, `stdout`/`stderr`
(`write`, `fd`, `isTTY`, `columns`, `rows`), `nextTick`, and the free `process` global under `--node`
(rewritten to `import process from "node:process"`); `node:process` 17/68, slice N1 25/37. `hrtime.bigint`
stays open. **`os`, `perf_hooks` and timers slice** (plan-notes 394, 395): `node:os` 14/23
(new `std/os` `kernelName`/`kernelVersion`/`machine` over `uname(2)`), `node:perf_hooks`
`performance` 16/69, `node:timers` 6/7, and the globals `performance` and the six timer functions
under `--node`; slice N1 30/37. Two compiler bugs fixed on the way: the inliner shared nodes with its
callee, and receiver calls guessed `this` from the argument count. The task stays open: N1 is not
100%. **Next**, in the order `tsc` needs them: `Buffer.from`/`toString` (then `readFileSync` without
an encoding answers a `Buffer`), `crypto.createHash`, `hrtime.bigint`; `path.win32` is its own slice
(13 of T11.7's `path` tests need it).

**Check:** `tsc --version` and `tsc -p` on a small fixture project, compiled by Stator, print
byte-for-byte what `node _tsc.js` prints on Node 26.7.0; `docs/NODE.md` slice N1 at 100%.
