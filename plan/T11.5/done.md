# T11.5. Closing report

**Phase 11 — T11.5 `--node` and CommonJS ✅ (2026-10-02)**

**Check — PASSED** (2026-10-02, on main 9a26b03):

- Decision tests for `require` in all four mode × platform cells (`subset_commonjs_require_*`,
  all `STA1110`), for a CommonJS project file in all four (`subset_commonjs_file_*`, the `js` +
  `--node` cell in `unit/bundler.test.ts`), and for `__filename`/`__dirname` and `import.meta`
  (`subset_node_filename_*`, `subset_node_dirname_*`, `subset_node_import_meta_*`):
  `pnpm run test:subset` → `subset: 887 fixtures — 854 passed, 33 expected-fail, 0 failed`.
- Goldens byte-for-byte vs Node: `createRequire` of a built-in, a computed `require` hit (a
  built-in) and miss (`MODULE_NOT_FOUND`), in `ts/node_module.ts` and `js/node_module.js`:
  `pnpm run test:golden` → `golden: 433 fixtures — 433 passed, 0 failed`.
- The vendor module's injected `__filename`/`__dirname`, with a ready bundle in Rolldown's shape
  (`unit/bundler.test.ts`), and the `landed` table (`unit/node-module.test.ts`):
  `pnpm run test` → `Tests  720 passed (720)`.
- `pnpm run ci` → exit 0 (typecheck, lint, dupes at 188 clones, runtime, unit, runtime corpus,
  subset, golden, selfhost at 13 targets, builtins, node-coverage, leak, ASan).

Left to other cards: `esmExternalRequirePlugin` in `vite-stator` (T12.2) and the CommonJS goldens
through the default adapter (T12.3). The CJS cycle and `module.exports` replacement goldens moved
to T12.3 earlier.

The stub `plan.md` kept when the task closed:

~~**T11.5. `packages/compiler`: the `--node` flag and CommonJS.**~~ ✅ **landed 2026-10-02** —
evidence above (plan-notes 312, 315, 316). The `vite-stator`
side of a bundled built-in (`esmExternalRequirePlugin`, which turns the bundle's `__require` of a
built-in into an import) is T12.2's; the CommonJS goldens through the default adapter are T12.3's.
