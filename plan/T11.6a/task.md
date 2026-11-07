---
status: in progress
priority: P1
complexity: 4
readiness: 100%
agent: Claude Code / claude-opus-5-5
---

# T11.6a. `packages/compiler`: a class that extends `Uint8Array`

Creator's direction (2026-11-06): a prerequisite of T11.6. Node's `Buffer` is a `Uint8Array`
subclass, and `tsc` reads `buf[0]`, `buf.length` and `buf.toString("utf8", 3)` straight off it.
Today `class B extends Uint8Array {}` is `STA1214` ("extending anything but a class declaration",
Phase 5), so `packages/node` cannot declare `Buffer` as Node does. This card lets a user class
extend the builtin `Uint8Array`, and `Buffer` is then written in strict TS in `packages/node`
(T11.6).

Done means a class extending `Uint8Array` compiles in both modes and behaves as on Node 26.7.0:
- construction and indexing;
- `length` and the landed `Uint8Array` members;
- its own methods and statics;
- `instanceof` both ways;
- species: `subarray` and `slice` answer the subclass;
- `console.log`;
- passing it where a `Uint8Array` is expected, including an extern `bytes` parameter.

## Design

- **The type.** An instance stays an HType `uint8array`, tagged with its class:
  `HUint8Array.subclass`. Indexing, `length`, `subarray`, iteration and the extern `bytes` ABI are
  then the existing typed paths unchanged. The class part is only what a plain view lacks: its own
  methods (checked before the `TYPED_OPS` row, so an override wins), its statics, `new`,
  `instanceof`, and its descriptor.
- **The layout.** A view already begins with `const JSRTClass *cls` (`JSRTTypedArray`). The
  subclass's descriptor has `parent = &jsrt_class_uint8array` and no fields, so `cls->methods`
  dispatch and the `parent` walk in `instanceof` work on a view unchanged.
- **The runtime.** Every exact test of `&jsrt_class_uint8array` becomes "this class or a
  descendant". That covers `jsrt_is_uint8array`, `asView`/`requireView`/`receiverText` in
  `jsrt_typed.zig`, `jsrt_is_fixed_object` and the iterator. A dynamic property read on a
  subclass view answers the class's own methods before the bound `Uint8Array` ones. `subarray`
  and `slice` copy the receiver's `cls` (species).
- **Gate.** The subclass declares no instance fields, no constructor, no accessors and no
  `#private` members, and sits non-generic at module scope. Each class in the chain is held to
  the same rule. Anything wider stays `STA1214`. Without a constructor, species construction is
  exactly "same `cls`, new view", which is why the constructor is held back.

## Steps

1. The gate (`gate.ts` `gateHeritage`, plus the Zig `gate_class.zig`): allow a base that is the
   global `Uint8Array` under the rule above. Add decision tests for both modes, accept and refuse.
2. Types: `HUint8Array.subclass`, set by the frontend (`types.ts`, `gate_types.zig`) for an
   instance of such a class. `hTypeKey` keeps the name; assignability sends a subclass to
   `Uint8Array`, not back.
3. Lowering and codegen: `new Sub(a, b, c)` pads its arguments as `new Uint8Array` does and calls
   a new `jsrt_uint8array_new_class(cls, …)`. Own methods, statics and `instanceof` take the class
   paths; the descriptor's parent is `&jsrt_class_uint8array`. Mirror all of it in
   `packages/compiler-zig`.
4. Runtime: the chain-aware view test, species-preserving `subarray`/`slice`, the dynamic get
   reading the class's methods first, and `console.log` printing `B(n) [Uint8Array] [ … ]` as Node
   does.
5. Goldens `ts/uint8array_subclass.ts` and `js/uint8array_subclass.js`, plus docs: `docs/VALUE.md`
   §4.19, `docs/SUBSET.md` and plan-notes.

## Check

The goldens `ts/uint8array_subclass.ts` and `js/uint8array_subclass.js` print byte for byte what
Node 26.7.0 prints. The decision tests pass. `pnpm run test:zigdiff` is no worse than its
baseline, and the local `pnpm run ci` stages pass except those already red on `origin/main`.
