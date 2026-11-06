---
status: in progress
priority: P2
complexity: 4
readiness: 0%
agent: Claude Code / sonnet-5-5
---

# T12.3. `packages/compiler`: Rolldown's output compiles

Depends on T12.1, and overlaps T11.4's `Object.*` and method-call families. Do those first,
where they are the same constructs. Each item below is measured in T12.0 (`docs/BUNDLER.md`
§2, §4, §8), and each lands with decision tests in both modes plus a golden:

- ~~**`var X = class {}` / `let X = class {}`.**~~ Landed (plan-notes 323): a formation nothing in
  its file writes lowers like `const`.
- **The CJS interop helpers.** `__commonJSMin`, `__toESM` and `__copyProps` need
  `Object.create`, `Object.defineProperty` with getter descriptors,
  `Object.getOwnPropertyDescriptor`, `Object.getOwnPropertyNames`, `Object.getPrototypeOf`,
  `Object.prototype.hasOwnProperty.call` and `Function.prototype.bind`. `__commonJSMin` landed
  (plan-notes 323): its comma operator was an internal `STA4013`.
- **The dynamic-import namespace helpers.** `__esmMin` and `__exportAll` need
  `Symbol.toStringTag` and a zero-argument `Promise.resolve()`.
- ~~**`import.meta.url`.**~~ Landed under `--node` by T11.5 (plan-notes 316).
- ~~**A computed `export default`.**~~ Lowers since T11.5a (`subset_export_default_expression_*`,
  plan-notes 323).
- **The package imports T12.1 leaves refused** (plan-notes 320 Q3), each `STA1214` today:
  ~~`export * from 'p'`~~, whose names come from the bundle's own exports once it is built (landed
  for one such package per build, plan-notes 323); `import('p')`, which lands on the
  dynamic-import namespace helpers above (a clean `STA1214` now, not the internal `STA4031`); and
  ~~a package import with import attributes~~ (landed, plan-notes 323).

`__filename`/`__dirname`: T11.5 injects them in the vendor module under `--node` (plan-notes
316, proved with a ready bundle in `unit/bundler.test.ts`); a golden here may read them, printing
no path.


**Execution plan** (measured on 0afd141 with 12 probe fixtures through the default adapter):

1. **First slice, no overlap with T11.4:** the comma operator types as its right operand
   (`__commonJSMin`'s `STA4013`); `var`/`let X = class {}` that nothing repoints lowers like
   `const`; attributed package imports reach the entry; `export * from` one package re-exports
   the names the built bundle exports for it; `import('p')` becomes a clean `STA1214` instead of
   the internal `STA4031`. Goldens: nested `require`, CJS cycle, `.cjs` entry,
   `node_pkg_location`, top-level class, `export *`, attributed JSON import, the comma itself.
2. **Blocked, needs a decision:** `__toESM`/`__copyProps` (default import of a CJS package,
   `module.exports` replacement) need T11.4 step 8's `Object.*`. `__exportAll` (namespace import,
   `import('p')`, a package's inlined `import()`) also needs `Symbol.toStringTag`, which is
   `STA1212` (Phase 5): the runtime has no symbol values.

**Check:** CommonJS goldens through the default adapter, byte-for-byte vs Node:

- `exports.x` (by name: `js/node_pkg_location`, plan-notes 323; a default import goes through
  `__toESM`);
- `module.exports` replacement;
- a nested `require` (`js/pkg_cjs_nested_require`);
- a CJS cycle that exposes partial `exports` (`js/pkg_cjs_cycle`);
- a `.cjs` project entry (`js/node_cjs_entry`);
- a package with an inlined dynamic `import()`;
- a package with a top-level class (`js/pkg_class`).
- a project file with `export * from 'p'` (`js/pkg_export_star`), one with `import('p')`, and one
  with an attributed package import (`with { type: 'json' }`; `js/pkg_import_json`).
- a namespace import of a package (`import * as p from 'p'`), which Rolldown answers with
  `__exportAll`; moved here from T12.2 (plan-notes 321).

`explain` on T12.0's `cjs` spike bundle lists no `STA1214`.
