---
status: in progress
priority: P1
complexity: 4
readiness: 100%
agent:
---

# T11.5a. `packages/compiler`: per-module namespaces

Creator's direction (2026-10-02, plan-notes 302). This is a prerequisite of T11.6. Today one
program has **one** namespace, so three things go wrong:
- Importing a module reserves all of its top-level names, exported or not, for the whole program.
  A user `function get()` next to `import { has } from "std/env"` is `STA1214`.
- Every aliasing shape is `STA1214` (docs/SUBSET.md, "Renamed/default/namespace imports" and
  "Re-exports" rows), so a library cannot hide its helpers or rename what it exports.
- `packages/node` would hit both on every module (plan-notes 294).

Steps:
1. **Per-module symbols.** Every module's top-level bindings get a module-qualified C name. Two
   modules may then declare the same name, and a module's unexported names are invisible to
   others. Diagnostics and `#line` mapping keep the source name.
2. **Aliasing imports.** `import { x as y }`, default imports, and `import * as ns` as a static
   namespace object. A static `ns.x` resolves at compile time, like the `import()` namespace from
   Phase 5 step 10. A namespace that escapes as a value uses that same `HObject`
   (`namespace: true`).
3. **Aliasing exports.** `export { x as y }`, `export default`, and re-exports:
   `export { x } from`, `export * from` (with ES ambiguity rules: a name exported twice by `*` is
   dropped, not an error) and `export * as ns from`. This takes over T12.1 step 3's
   `export { a as b }`. Whichever card lands first owns it, and the other cites it.
4. **Both modes, both kinds of graph.** The same rules apply to `ts`-mode modules, `js`-mode
   modules and mixed graphs. `std/*` and the T12.1 vendor module are ordinary modules here,
   with no special case.
5. **Docs.** Flip the SUBSET.md rows. The Phase 5 step 12 line that still owns `import * as ns`
   cites this card. Update MODES.md if init order or live bindings show a Node difference.

**Check:**
- A user `function get()` beside `import { has } from "std/env"` builds.
- Two modules with a same-named private helper build and run as under Node.
- Decision tests flip `not-yet` → `static` for every aliasing shape in both modes, removing the
  `// @expected-fail` markers in the same commit.
- Goldens cover renamed imports and exports, default, `import * as ns`, `export *` with an
  ambiguous name, and a re-export chain. Each matches Node byte for byte.
- `STA1214` is no longer emitted for those shapes, and the `test262` `language/module-code`
  pass count rises, recorded in plan-notes.
