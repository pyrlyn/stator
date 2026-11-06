# T11.1. Closing report

**Phase 11 — T11.1 typed arrays ✅ (2026-10-02)**

**Landed.** Runtime: `packages/runtime/src/jsrt_typed.zig` (new) holds the two classes, the
storage (an atomic, zero-filled byte block per buffer; `jsrt_gc.zig` gained `allocAtomic`), every
entry point and the method closures the dynamic tier hands out; `jsrt_value.h` declares the
layouts and the C ABI. C hooks: `jsrt_get_prop` → `jsrt_typed_get_prop`, `jsrt_dyn_index_get`/`_set`,
`jsrt_get_iterator` (`JSRT_ITER_UINT8ARRAY`), `console.log` (`inspect_list` now prints arrays and
views from one layout; `inspect_heap` is the shared builtin dispatch), `String()` /
`JSON.stringify`, `instanceof`, and `is_fixed_shape_object`. Compiler: `TYPED_OPS` rows for
`new ArrayBuffer`, `new Uint8Array`, `ArrayBuffer.prototype.byteLength`/`slice`,
`Uint8Array.prototype.length`/`byteLength`/`byteOffset`/`buffer`/`subarray`/`slice`/`set`; the gate
refuses everything else by its qualified name (`STA1214`, phase 11); verifier `STA4101`;
codegen's `indexGetCall`/`indexSetCall` pick `jsrt_uint8array_get`/`_put` for a `uint8array`
target. Tests: decision tests `subset_typed_arrays_{ts,js,dynamic_ts,dynamic_js,not_yet_ts,not_yet_js}`,
goldens `ts/typed_arrays.ts` + `js/typed_arrays.js` (the js one also drives the dynamic tier),
`unit/typed-arrays.test.ts`. Docs: `docs/SUBSET.md` (two rows, plus `for-of` and `instanceof`),
`docs/VALUE.md` §4.19, `docs/DIAGNOSTICS.md` STA4101, `builtins_coverage.json` (globals
`Uint8Array`/`ArrayBuffer`; namespaces `Uint8Array`, `Uint8Array.prototype`, `ArrayBuffer`,
`ArrayBuffer.prototype`).

**Known ceilings** (documented in docs/SUBSET.md): an expando write on an untyped view panics with
`STA2004`, like every statically shaped builtin; a dynamic call of an unlanded method reads
`undefined` and throws the missing-method TypeError; `Object.keys` on a view is refused by the
existing argument gate; a constructor of another element type falls under the generic `new`
refusal. No runtime print corpus was added: the corpora are `.mjs` scripts, the no-JS rule (plan.md §0
item 10, plan-notes 289) stops a new one until Task 6.15 migrates them, and the goldens prove the
same printer against Node.

**Check — PASSED** (2026-10-02, rebased on T11.2 `ce66355`):
- decision tests: `node packages/tests/subset/run.ts` → `subset: 767 fixtures — 730 passed, 37 expected-fail, 0 failed` (six new typed-array fixtures, both modes, static / dynamic / not-yet);
- goldens: `node packages/tests/golden/run.ts` → `golden: 404 fixtures — 404 passed, 0 failed`;
- `node packages/tests/golden/builtins.ts` → `builtins: 234/294 surface members landed (80%)`, listing `Uint8Array: 0/5`, `Uint8Array.prototype: 7/40`, `ArrayBuffer: 0/1`, `ArrayBuffer.prototype: 2/8`;
- ASan: `node packages/tests/golden/asan-gate.ts` → `golden: 404 fixtures — 404 passed, 0 failed` under ASan/UBSan, `golden-asan green`;
- also clean: `tsc` (compiler, tests, std), `oxlint --deny-warnings`, `oxfmt --check`, `cpd` (217 clones, no new ones against the baseline), `vitest` (47 files, 613 tests), `node-coverage --check`, `just runtime-test`, `zig fmt --check`.

The stub `plan.md` kept when the task closed:

~~**T11.1. `packages/runtime`: typed arrays.**~~ ✅ **landed 2026-10-02** — `ArrayBuffer` +
`Uint8Array`; evidence above Still open from the card: the rest
of the `TypedArray` family lands with the card whose corpus first needs it (docs/SUBSET.md lists
the refused surface, `builtins_coverage.json` counts it as missing).
