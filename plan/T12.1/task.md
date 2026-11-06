---
status: in progress
priority: P2
complexity: 4
readiness: 100%
agent:
---

# T12.1. `packages/compiler`: the bundler API

Depends on T12.0. Contract: `docs/BUNDLER.md` §5–§7.

**Landed 2026-10-02** (plan-notes 320). The execution plan it was claimed with:

1. `src/api.ts` (`statorc/api` in `package.json` `exports`): the §5 types, `compile` and
   `vendorEntry`. Adapter and bundle results are `unknown` until validated (golden rule 4).
2. `src/frontend/vendor.ts`: collect package imports (bare, not `node:*`, a built-in or `std/*`)
   and CommonJS project files from the loaded program, mangle names, generate the entry.
3. Same module: rewrite each project import of a package into an import of one virtual
   `__stator_vendor__.js` module, line count kept; `createProgram` takes the overlay (the
   rewritten files plus the bundle) and its cache key gains the bundle's sha256 (step 6). The
   module graph resolves edges through the checker, so the virtual module is an edge.
4. `src/cli/bundler.ts`: `--bundler` on `build`/`explain` and the config key; STA0004 in `ts`
   mode, STA0014 when the adapter cannot load, STA0015 when `bundle()` rejects or returns no
   valid bundle. `build` and `explain` share one frontend driver.
5. `src/support/sourcemap.ts`: one wrapper over `node:module` `SourceMap`. Diagnostics in the
   vendor module are mapped after each stage; the lowering maps vendor spans, so `#line` and
   `jsrt_call_at` strings name the original file, or `<package bundle>` with no mapping.
6. Card step 7: the gate raises a new `not-yet` code (STA1218, Phase 11) for a free `__filename` or
   `__dirname`; `program.ts` drops the checker's "cannot find name" for the two names so the
   gate's verdict stands in both modes.

Tests: unit tests over a stub adapter (vendor entry, rebinding, mapping, STA0014/STA0015),
decision tests for STA1218 in both modes, and the `js` goldens under `--bundler=none` and the
default. Docs: `BUNDLER.md`, `MODES.md`, `HOW-IT-WORKS.md`, `DIAGNOSTICS.md`, `CONFIG.md`,
`pipeline.d2`; plan-notes 320, changelog v4.40.

1. **The API.** `statorc/api`: a programmatic `compile` that takes an optional vendor bundle
   (`{ code, map, inputs }`), and the adapter interface
   `BundlerAdapter = { name, bundle(entry: { code, resolveDir }, { external }) → Promise<{ code, map, inputs }> }`.
2. **The vendor entry.** After the program loads, collect the package imports and route the
   CommonJS project files. Generate the vendor entry:
   - named imports become `export { a } from 'p'`;
   - default and namespace imports get mangled names;
   - a name is mangled only on collision.
3. **The vendor module.** Add the bundle as one virtual `js`-mode module and rebind the
   imports to its exports. `export { a as b }`, the form Rolldown emits for renamed exports, is
   lowered already: it landed with §11c T11.5a step 3 (`subset_export_renamed_*`).
4. **The CLI.** `--bundler=vite|none|<module>` on `build` and `explain`:
   - the default in `js` mode is `vite`, loading `vite-stator`;
   - in `ts` mode the flag is `STA0004`;
   - the adapter loads only when step 2 found something;
   - `STA0014` means the adapter cannot be loaded, and its message names the package;
   - `STA0015` means the bundle step failed, with the bundler's message passed through.
5. **Source maps.** Diagnostics, `#line` and runtime call-site strings in the vendor module
   map through the source map (`node:module` `SourceMap`, wrapped once in `src/support/`;
   stability 1.1). A position with no mapping says it sits in a bundler runtime helper, never
   a user file.
6. **The cache.** The program-cache key (Task 6.9) adds the sha256 of the vendor `code`.
7. **`__filename`/`__dirname`.** Without `--node`, a free read of either in a project file
   or in the vendor module is a `not-yet` diagnostic naming T11.5 (BUNDLER.md §4, §9). Inside
   the vendor module it is reported at the mapped position. The code is allocated in
   `docs/DIAGNOSTICS.md` when this lands.

   Today such a read compiles as `dynamic`, and the binary throws `ReferenceError` where Node
   prints the path. No path is ever baked into the binary.

Docs: `HOW-IT-WORKS.md`; `MODES.md`, covering packages, the vendor module and the
package-evaluation-order deviation (BUNDLER.md §1, documented only, no card closes it), the
latter next to top-level-await interleaving in §5; `DIAGNOSTICS.md` (STA0014/STA0015 move from
planned to emitted, plus step 7's code); `pipeline.d2` (a dependency-bundling stage before the frontend in
`js` mode).

**Check:**

- Unit tests drive `compile` and the vendor-entry generator through a stub adapter.
- Every existing `js` golden passes byte-for-byte under `--bundler=none` **and** under the
  default, with Vite not installed. None of them imports a package, so the adapter must not
  load.
- A diagnostic inside a vendored module reports the original file and line. One inside a
  runtime helper says "no source mapping".
- `STA0014` is raised for a package import when the adapter is absent.
- Decision tests: `__filename`/`__dirname` are `not-yet` in a project `.js` without `--node`.

**What landed.**

- `src/frontend/vendor.ts`: package imports and CommonJS project files out of the loaded
  program; the vendor entry with mangled names; the in-place rewrite of each project declaration
  to `./__stator_vendor__.js`, every line kept, type-only names split onto the original module.
- `src/cli/bundler.ts`: the one frontend driver `build`, `explain` and `statorc/api` share. It
  loads the adapter by name only when the vendor plan is not empty, checks every answer
  (golden rule 4), reloads the program over the overlay, and maps diagnostics.
- `src/frontend/program.ts`: `createProgram` takes the overlay; the program cache has two slots
  and keys on the overlay's sha256 as well. `src/frontend/graph.ts` resolves edges through the
  checker, so the virtual module is an edge.
- `src/support/sourcemap.ts`: the wrapper over `node:module` `SourceMap`. The lowering maps
  vendor spans, so `#line`, `jsrt_call_at` strings and STA2001 locations name the package file,
  or `<package bundle>`.
- `--bundler=vite|none|<module>` on both commands and the `bundler` config key (schema
  regenerated). STA0014, STA0015 emitted; STA0004 for `--bundler` in `ts` mode.
- `src/api.ts` (`statorc/api` in `package.json` `exports`): `compile`, `vendorEntry`, the §5 types.
- STA1218 (step 6) for a free `__filename`/`__dirname`, in both modes.
- Decisions this card had to make (CommonJS routing narrowed to files that read `require`,
  `module` or `exports`; `sources` resolved against `resolveDir`; `export *`/`import()` of a
  package left refused): plan-notes 320.
