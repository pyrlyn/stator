# Self-compilation diagnostics for `packages/compiler`

`pnpm run test:selfhost` runs `stator explain` over the compiler itself
(`packages/tests/selfhost/targets.json`). The compiler is still `not-yet`. This page records what
the gate refuses in it and what has been fixed.

## How it works

Two gate rules changed in `packages/compiler/src/frontend/gate.ts`:

1. **Qualified type names are erased.** `ts.Node`, `NodeJS.Platform` and `m.T` are the entity
   names of a type reference. The gate already skipped type nodes, but it still visited their
   `QualifiedName` child as if it were a value and refused it as "this construct (QualifiedName)".
   It now returns before gating a `QualifiedName`, the same way it treats the type node around it.
2. **for-of over a tuple.** `for (const k of KEYS)` where `KEYS` is `[...] as const` or `[A, B]`
   was refused as a "user iterable". Tuples are arrays at run time (`isArrayOrTuple`,
   `frontend/types.ts`), so the for-of gate now accepts them like arrays. Lowering was already
   correct; the probe below prints the same output as Node.

## Enable / disable

These are always on, with no flag. To undo either one, revert its hunk in `gate.ts` and run
`node packages/tests/selfhost/run.ts --update`.

## Test

- `pnpm run test:selfhost`: the ratchet. `packages/compiler` STA1214 went from 1887 to 454.
- `pnpm test`: `selfhost.test.ts` covers a qualified type name (`m.T`) and for-of over
  `as const` and `[number, number]` tuples.
- `pnpm run test:subset` and `pnpm run test:golden` are unchanged and pass.

## Limitations

The 457 diagnostics left (454 STA1214, 2 STA1213, 1 STA1207) need real Phase 5/6/12 features
rather than one-line gate fixes. The main groups:

- for-of over `ts.NodeArray` (an interface extending `ReadonlyArray`): 69 sites.
- Importing a package (`typescript`, `typebox`, `ink`, and so on): 67 sites.
- A generic function used as a value (`Type.Object(...)`): 63 sites.
- Index access on a `Record`: 61 sites.
- The `process` global: 43 sites.
- `new Set(iterable)`: 35 sites; `new Map(iterable)`: 21 sites.
- Destructuring in a for-of binding: 27 sites.

`x satisfies T` (16 sites) is **not** erased. A probe that erased it miscompiled an object
literal typed by its `satisfies` context, printing `2.16e-314` instead of `1`.
