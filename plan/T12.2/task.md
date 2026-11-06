---
status: in progress
priority: P2
complexity: 3
readiness: 100%
agent:
---

# T12.2. `packages/vite-stator`: the default integration

Depends on T12.1. New workspace package, strict TS (§0.10). `vite` is a `peerDependency`
(plan-notes entry: the integration *is* Vite, no few lines replace it). It ships:

- the adapter `stator build --mode=js` uses by default, configured per BUNDLER.md §2:
  - an SSR build with `ssr.noExternal: true` and `ssr.target: 'node'`. Library mode is wrong:
    it stubs `node:*` out;
  - Rolldown output `format: 'es'`, `codeSplitting: false` and `topLevelVar: false`;
  - `minify: false`, `sourcemap: true`, `std/*` external;
  - Vite's `esmExternalRequirePlugin` for built-ins;
  - no `__filename`/`__dirname` transform. They stay free, and T12.1 reports them as
    `not-yet` (BUNDLER.md §9);
- the `stator()` Vite plugin (`vite build` produces the native binary);
- an example under `examples/vite/` with its README.

**Check:**

- New goldens with a `node_modules` package pass through the default adapter, byte-for-byte
  vs Node: named, default and namespace imports, and two packages sharing a dependency (one
  instance).
- `examples/vite` builds a binary with `vite build`.
- Tree-shaking, measured on a package, because project code is already tree-shaken by
  Stator's DCE (BUNDLER.md §1, 93 976 B both ways). Import 1 of 40 functions from a package:
  - the vendor module holds only that function;
  - the binary is within 1% of the same function written in the project.
  The numbers go in plan-notes.

**Landed 2026-10-02** (plan-notes 321). The execution plan it was claimed with:

1. `packages/vite-stator` (workspace package, strict TS): `src/adapter.ts`, the default adapter,
   with §2's configuration as one Vite SSR build of an in-memory vendor entry; `src/plugin.ts`,
   `stator()`; `src/index.ts` (default export = the adapter). `vite` is a peer and a dev
   dependency at the version the lockfile already holds; root `devDependencies` gains
   `vite-stator` so the compiler resolves it. tsconfig, `typecheck`, moon project, TOOLCHAIN.md.
2. Goldens `packages/tests/golden/js/pkg_*` with a committed `node_modules` (`.gitignore`
   exception): named, default and namespace imports, and two packages sharing one dependency.
   `golden/run.ts --bundler=none` skips fixtures that hold a `node_modules`.
3. `examples/vite`: a workspace example whose `vite build` writes a native binary; a unit test
   runs it.
4. Tree-shaking: a 40-function package, one imported; the vendor module and the binary size
   against the same function in the project, in plan-notes.
5. Docs (BUNDLER.md, README, AGENTS.md repo map, TOOLCHAIN.md), plan-notes, changelog, done.md.

**Re-scoped on landing (plan-notes 321).** The namespace import of a package moved to T12.3's
Check: the vendor entry's `export * as p$ns` makes Rolldown emit `__exportAll`
(`Object.defineProperty`, `Symbol.toStringTag`), T12.3's helper item. Vite is pinned at 8.3.1,
not the latest 8.3.2, because 8.3.2 is inside pnpm's `minimumReleaseAge` and would bump vitest's
`vite` (open for the creator).

**What landed.**

- `packages/vite-stator`: `src/adapter.ts` (one `vite.build()` per compile: the vendor entry
  served in memory as `<resolveDir>/__stator_vendor_entry__.js`, `outDir: resolveDir` with
  `write: false` so map sources are relative to `resolveDir`, one chunk or an error),
  `src/plugin.ts` (`stator({ entry, out?, mode? })`: `build.ssr` at the entry with nothing
  written, `compile` in `closeBundle`, the Vite build fails on a failed compile), `src/index.ts`,
  tsconfig, `moon.yml`; root `typecheck` and moon's `tests:ci` include it.
- The adapter passes the external list to `esmExternalRequirePlugin` only, so `require` of a
  built-in becomes an `import` (Rolldown's own `external` pre-empted the plugin; plan-notes 321).
- `examples/vite`: `src/main.js` imports `greeting` (`link:./greeting`); `vite build` writes
  `dist/hello`.
- Goldens `pkg_imports` and `pkg_shared_dependency` with committed `node_modules`;
  `golden/run.ts --bundler=none` skips them and says so.
- Docs: BUNDLER.md (status, "As implemented (T12.2)", the plugin, §8), README, AGENTS.md repo map,
  TOOLCHAIN.md (`vite`, `vite-stator`), ARCHITECTURE.md and `packages.d2`/`.svg` (the package is
  loaded, never imported), `examples/vite/README.md`.
