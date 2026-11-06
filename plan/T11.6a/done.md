# T11.6a. Closing report

A class that extends the builtin `Uint8Array` compiles in both modes (plan-notes 397). An
instance is a view stamped with its own class: the HType stays `uint8array` with a `subclass`
tag, so indexing, `length`, the landed `%TypedArray%` members, iteration and the extern `bytes`
ABI take the existing typed paths, and only the class's own methods, statics, `new`,
`instanceof` and descriptor take the class paths.

## What landed

- **Gate** (`frontend/gate.ts`, `gate_class.zig`): a non-generic, module-scope class whose chain
  ends at the global `Uint8Array` may declare methods and statics. A constructor, an instance
  field, an accessor or a `#private` member stays `STA1214` (Phase 11), because species
  construction is "same class, new view" only without a constructor.
- **Types** (`hir/types.ts`, `hir/types.zig`): `HUint8Array.subclass` and `classLayoutOf`. A
  subclass is assignable to `Uint8Array` and to its bases, not back, and its conversions run user
  code (an override of `toString`/`valueOf`).
- **Lowering, verifier, codegen**: `new Sub(…)` is the `new Uint8Array` typed op with
  `viewClass`, emitted as `jsrt_uint8array_new_class(cls, …)`. The root descriptor's parent is
  `&jsrt_class_uint8array`. The verifier accepts a subclass instance in an extern `bytes` slot.
- **Runtime**: `jsrt_class_is_uint8array` walks the parent chain and replaces every exact
  `&jsrt_class_uint8array` test (`jsrt_is_uint8array`, `asView`, the receiver text, the fixed
  object test, the iterator). `subarray` and `slice` keep the receiver's class (species). A
  dynamic property read tries the class's methods first. `console.log` prints `Name(n)
  [Uint8Array] [ … ]` as Node does. `jsrt_typed.zig` gained one generic `require(T, …)`.
- **Zig port** (`packages/compiler-zig`): every change mirrored. `golden/ts/uint8array_subclass.ts`
  is `different` in the lower stage only: the Zig TS checker in `packages/transpiler` types
  `this[i]` on the polymorphic `this` as a deferred access instead of `number | undefined` (a
  named receiver already types correctly). That fix belongs to the transpiler. The count stays
  under the zigdiff baseline.
- **Tests**: goldens `ts/uint8array_subclass.ts`, `js/uint8array_subclass.js` and a subclass case
  in `ts/extern_bytes`; decision tests `subset_uint8array_subclass_{ts,js}` (static) and
  `subset_uint8array_subclass_not_yet_{ts,js}` (`STA1214`); a unit test in `types.test.ts`.
- **Docs**: `docs/VALUE.md` §4.19, `docs/SUBSET.md`, plan-notes 397.

## Check

Run on arm64 macOS on top of `origin/main` 0fc90934, pinned Node 26.7.0, Zig 0.17.0, with
`packages/transpiler` and `packages/jstext` listed in `selfhost/targets.json` locally only:

- goldens: 501/501 plain and 501/501 under ASan/UBSan (`uint8array_subclass` ts and js byte for
  byte against Node);
- subset: 1020 fixtures, 989 passed, 31 expected-fail, 0 failed;
- unit: 816/816; `test:runtime` print corpus matches Node; `test:leak` plateaus;
- typecheck, lint and `test:node-coverage` clean; selfhost: 20 targets match the baseline;
- dupes: no new clone (65 not in the baseline outside `packages/transpiler`, against 67 on
  `origin/main`);
- zigdiff: lower 10 different (baseline 11); `lower.refused` 13 against a baseline of 11 is the
  same on `origin/main`.

Red on `origin/main` and not touched here: `check-node` (`mise.toml` selects Node 26.12.0
while `.node-version` pins 26.7.0), `check-js-sources` (`packages/transpiler` `.mjs`), `dupes` (`packages/transpiler`), the
selfhost `targets.json` gap (`packages/transpiler`, `packages/jstext`), zigdiff `lower.refused`.
