---
status: in progress
priority: P1
complexity: 4
readiness: 100%
agent:
---

# T11.1. `packages/runtime`: typed arrays

`Buffer` is a `Uint8Array` subclass, and every byte-level API (file reads, hashes, codecs) needs
a byte container; the tree has none. Steps: `ArrayBuffer` + `Uint8Array` first (constructor
forms, indexing, `length`, `subarray`, `set`, `slice`, iteration), storage in Zig (§0.5), then the
rest of the `TypedArray` family only as the corpus needs it. Docs: `docs/SUBSET.md` rows,
`builtins_coverage.json` namespaces.

**Check:** decision tests (both modes) + goldens for every landed member; `test:builtins` lists
the new namespaces; ASan clean.

**Execution plan (Claude Code / opus-5-5, branch `t11-1-typed-arrays`):**
1. Runtime: `JSRTArrayBuffer` / `JSRTTypedArray` layouts + entry points in `jsrt_value.h`; storage,
   construction, element get/set (ToUint8), `subarray`/`slice`/`set`, `ArrayBuffer.slice` and the
   dynamic-method closures in a new `src/jsrt_typed.zig` (byte storage is pointer-free memory).
   C hooks only where the existing C dispatches: `jsrt_get_prop` / `jsrt_dyn_index_*` (dynamic
   tier), `jsrt_get_iterator` (a typed-array walk kind), `console.log` (Node's `Uint8Array(n) [ … ]`
   / `ArrayBuffer { [Uint8Contents]: <…>, [byteLength]: n }`), `String()` / `JSON.stringify`,
   `instanceof`.
2. Compiler: HTypes `uint8array` and `arraybuffer` (leaves -- the next element type is a new leaf
   and new rows, not a generic); one HIR node `typed-op`
   driven by one table (`TYPED_OPS`, hir/nodes.ts) that the gate, lowering, verifier (new
   STA4101) and emitter all read; `u[i]` / `u[i] = v` reuse the index nodes; `for-of` goes through
   `get-iterator` with a `number` element.
3. Tests: decision tests (ts + js, static + a dynamic js case + not-yet for unlanded members),
   goldens `ts/typed_arrays.ts` + `js/typed_arrays.js` (+ dynamic js), ASan gate.
4. Docs: `docs/SUBSET.md` row, `docs/VALUE.md` §4.19, `docs/DIAGNOSTICS.md` STA4101,
   `builtins_coverage.json` namespaces; then the record moves to `done.md`.
