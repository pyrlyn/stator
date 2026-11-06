---
status: in progress
priority: P2
complexity: 3
readiness: 100%
agent:
---

# T12.0. Design: the bundler contract

Docs first (§15.6): `docs/BUNDLER.md`, settled with a measured spike — one `js` golden fixture
bundled by Vite, compiled by Stator, output byte-for-byte equal to Node. Questions it must answer:

1. **Typed code in a mixed graph.** A bundler strips TS types, which would turn typed `.ts` in a
   `js`-mode graph dynamic. Options: bundle everything (all dynamic), or keep project `.ts` out of
   the bundle as typed modules and bundle only JS (`node_modules`, `.js`). Measure both.
2. **Output contract.** One ESM chunk, no code splitting (dynamic `import()` inlined), no
   minification by default (names show up in diagnostics and stack traces), a source map always.
3. **Externals.** `std/*`, `node:*` and bare built-ins stay external and are resolved by Stator
   (§11c packages).
4. **CommonJS.** If the bundler converts CJS, §11c T11.5 shrinks to the flag, the globals and
   external resolution — record the re-scope in T11.5 in the same change.
5. **The API.** `statorc/api` takes the bundle plus its source map; `BundlerAdapter` is
   `{ name, bundle(entry, options) → { code, map, inputs } }`; `--bundler=vite|none|<module>`; the
   default is `vite` in `js` mode. What happens when the default adapter is not installed — a
   `STA0xxx` naming the package, allocated in `docs/DIAGNOSTICS.md`.
6. **Diagnostics.** Every span in a bundled file maps back to its original file through the
   source map; a span with no mapping says so rather than pointing into the bundle.
7. **Caching.** How the bundle step participates in the program cache (Task 6.9) and in moon.

**Check:** `docs/BUNDLER.md` answers 1–7 with the spike's numbers; plan-notes records the choice;
T12.1–T12.2 are edited to match.
