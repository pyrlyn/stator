# T12.0. Closing report

**Phase 12 — T12.0 design ✅ (2026-10-02)**

**Check — PASSED** (2026-10-02): `docs/BUNDLER.md` answers questions 1–7 with the numbers from
`docs/research/bundler/spike.ts` (Vite 8.3.1 / Rolldown 1.2.12, Node 26.7.0). The choice is
plan-notes 296: bundle package imports and CommonJS project files into one vendor ESM module,
and keep the project `.ts`/ESM `.js` in Stator's graph.

The answers, measured:

1. **Typed code.** Bundling the whole graph turns `fib` from static to dynamic and drops
   `STA2001`. B keeps both.
2. **Output contract.** The bundle is one ESM file with `codeSplitting: false`,
   `topLevelVar: false`, no minification and a source map. It runs as an SSR build, because
   library mode stubs `node:*`.
3. **Externals.** `node:*`, built-ins and `std/*` stay ESM imports.
4. **CommonJS.** Rolldown's `__commonJSMin` converts it, so T11.5 loses its CJS lowering.
5. **API.** `BundlerAdapter.bundle(entry, { external })` returns `{ code, map, inputs }`.
   `--bundler=vite|none|<module>`, and the adapter loads only when the graph needs it.
6. **Diagnostics.** `node:module` `SourceMap` maps `bundle.js:3:9` back to `dep.js:4:10`.
   Runtime helpers are reported as unmapped.
7. **Caching.** The bundle step is 1–3% of a build and Rolldown has no persistent cache, so
   the vendor sha256 goes into the program-cache key.

Every bundle that compiled matched Node byte-for-byte. The one known deviation is the package
evaluation order, recorded in BUNDLER.md §1.

T12.1 and T12.2 were edited, T12.3 is new, and T11.5 was re-scoped, all in the same change.
The three questions in BUNDLER.md §9 were answered by the creator on 2026-10-02:

- "one file" means the dependencies;
- `__filename`/`__dirname` are `not-yet` until `--node`, with no paths baked into the binary;
- the order deviation is documented only.

The T12.1, T12.2, T12.3 and T11.5 cards were edited to match.

The stub `plan.md` kept when the task closed:

~~**T12.0. Design: the bundler contract.**~~ ✅ **landed 2026-10-02** — evidence above (plan-notes 296; `docs/BUNDLER.md`).
