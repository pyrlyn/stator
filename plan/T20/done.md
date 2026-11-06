# T20. Closing report

**Non-SDK names have an explicit rank, and the program cache hashes dependencies**

The empty-receiver `repeat` fixtures and the computed-key leak row were already T17 (`string_range_error`) and T16 (`keys.js`). The two notes still open were `compareSdkNames` and the program-cache key (plan-notes 357).

`compareSdkNames` parsed a non-matching name as `[]` and then filled both components with `0` via destructuring defaults, so `MacOSXbad.sdk` compared equal to `MacOSX0.0.sdk` and could sort as the newest fallback. A name that is not `MacOSX<major>[.<minor>].sdk` now has no version. It ranks below every versioned SDK, and two such names compare lexicographically. `pickFallbackSdk` only considers names that parse, so a garbage directory is never the chosen sysroot.

The program cache keyed on the entry's sha256 and the overlay key. An edit to an on-disk import left the entry hash unchanged, so a later watch mode would have served a stale `ts.Program`. The key now also hashes every other on-disk source file the program loaded. Default libs are omitted. Overlay files are omitted, because their bytes are the overlay key and a vendor module is not on disk. A dependency that cannot be re-read is a miss. That hash is the invalidation a watch mode must keep using (`docs/BUNDLER.md` §7).

Check: `pnpm exec vitest run --config packages/tests/vitest.config.ts packages/tests/unit/toolchain-sdk.test.ts packages/tests/unit/program-cache.test.ts packages/tests/unit/graph.test.ts` — `Test Files  3 passed (3)`, `Tests  15 passed (15)` (the new rows are the non-SDK rank and a transitive leaf edit that must miss). `pnpm exec tsc --noEmit -p packages/compiler/tsconfig.json` and `-p packages/tests/tsconfig.json` were clean. `pnpm exec oxlint --deny-warnings` on the touched sources was clean. `pnpm run dupes` reported 180 clones and exited 0 (no new clone). `stator explain` of `packages/compiler` reports `1844 × STA1214` (was 1845): the old `match[1] ?? ''` was one not-yet nullish coalescing, and the rank helper does not need it. The baseline records that shrink.
