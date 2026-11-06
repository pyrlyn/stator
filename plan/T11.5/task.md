---
status: in progress
priority: P1
complexity: 4
readiness: 100%
agent:
---

# T11.5. `packages/compiler`: the `--node` flag and CommonJS

Depends on T11.2. **Re-scoped by T12.0** (question 4, plan-notes 296; `docs/BUNDLER.md` §4):
the bundler converts CommonJS. Rolldown wraps each module as a function over
`(exports, module)`, and it already turns static `require` into graph edges, decides `"type"`
and gives CJS cycles Node's partial `exports`. Stator writes none of that. A CommonJS project
file (Node's rule: `.cjs`, `"type": "commonjs"`, or `.js` without ES-module syntax) is routed
to the bundler by T12.1, under `--node` only (decided 2026-10-02, plan-notes 315).

**Landed 2026-10-02** (plan-notes 312, 315, 316), in three changes: the steps that do not need
the bundler (312); `--node` gating CommonJS routing of project files (315); and the run-time
steps (316): `node:module` with a `require` over built-ins, `import.meta` under `--node`, and the
vendor module's `__filename`/`__dirname` injected relative to the executable. `STA1218` is
retired; every free CommonJS binding that reaches the gate is `STA1110`.

Steps:

- ~~**The flag.**~~ Landed (plan-notes 312): `--node` on `build` and `explain`, the config key
  `node`. An unlanded `node:*` module or member is `STA1214` naming Phase 11 (T11.6). A Node
  global member under `--node` joins this when `packages/node` declares its globals (T11.6).
- ~~**The Node globals' location.**~~ Decided (plan-notes 312, `docs/MODES.md` §6): relative to
  the executable, resolved at run time, never `import.meta.url`. Landed (plan-notes 316): the vendor
  module's values are injected; `STA1218` is retired.
- **Resolution.** ~~ESM imports in project files~~ landed (plan-notes 312): `node:*` and bare
  built-ins resolve to `packages/node` through `paths` entries. Landed (plan-notes 316): `node:module` and every landed built-in have a default export. The
  vendor bundle reaches them as `import * as m from "path"` plus `m.default`
  (`esmExternalRequirePlugin`), so built-ins need a default export (T11.6 provides it).
- ~~**`require` at run time.**~~ Landed (plan-notes 316). `import.meta.url` + `node:module.createRequire`
  give a `require` over built-ins only. It serves Rolldown's `__require` for computed
  `require(expr)`, and anything that is not a built-in throws Node's `MODULE_NOT_FOUND`. A
  computed require of a bundled file cannot resolve: Node itself fails on the bundle, as
  measured in T12.0.
- ~~**`STA1110`** narrows to "without `--node`".~~ Landed (plan-notes 312): it stays in `ts` mode
  with or without the flag, and in `js` mode without it. No new code.
- ~~**`--node` gates CommonJS routing.**~~ Landed (plan-notes 315): `planVendor` routes a CommonJS
  project file only under the flag, and the gate answers a free `module.exports` or `exports`
  with `STA1110` (it used to reach the lowering as `STA4035`).

Docs: `MODES.md` (platform section), `SUBSET.md`, `DIAGNOSTICS.md`, `HOW-IT-WORKS.md`,
`CONFIG.md` — updated for the landed steps.

**Check:** decision tests for `require` in all four mode × platform cells — **passing**
(`subset_commonjs_require_*`); for a CommonJS project file in all four — **passing**
(`subset_commonjs_file_ts` / `_node_ts` / `_js`, and the `js` + `--node` cell, which needs an
adapter, in `unit/bundler.test.ts`). Goldens, byte-for-byte vs Node: `createRequire` of a built-in, a
computed `require` hit (a built-in) and miss (`MODULE_NOT_FOUND`) — landed (plan-notes 316). The CJS
cycle and `module.exports` replacement goldens moved to T12.3.
