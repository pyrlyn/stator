# T65. Done

`pnpm run typecheck` now runs `node scripts/typecheck.ts`: it builds stator-ts
(`zig build -Doptimize=ReleaseSafe` in `packages/transpiler`, or takes `STATOR_TS`) and runs
`stator-ts check -p` on `packages/compiler`, `tests`, `std`, `node` and `vite-stator`. Exit 2 (type
errors) or any exit that is not a verdict fails the gate. The moon `typecheck` tasks call the same
script with their own project. `.github/actions/setup` installs Zig on Windows too, because every
`frontend` leg runs `typecheck`. `tsc` stays only for `pnpm run build`.

Three stator-ts false positives on this repository, each fixed in `packages/transpiler` with a
fixture that matches tsc 7:

- `exact-optional-infer-undefined`: under `exactOptionalPropertyTypes`, inference paired the
  `missing` of an optional-property read against a written `undefined` as different types and
  inferred `X | undefined` (TS2345 in `rewrite.ts`, TS2322/TS18048 on execa's `stdout`).
- `conditional-infer-outer-constraint`: `infer U extends S` read `S` without the conditional's own
  mapper (TS2769 in `extern_link.test.ts`, through execa's `MergeOptions`).
- `unused-exported-destructuring`: `export const { a, b } = …` was reported unused under
  `noUnusedLocals` (TS6198 in `packages/node/src/process.ts`).

Branch: `t65-typecheck-stator-ts` (a1ee0732 + this change).

How it was checked:

- Planted `export const planted: number = 'x';` in each of `packages/compiler/src`,
  `packages/tests/unit`, `packages/std/src`, `packages/node/src` and `packages/vite-stator/src`:
  `node scripts/typecheck.ts` exits 1 with one TS2322 and `typecheck: <project> has type errors`
  each time. Without the planted file it exits 0.
- `tests/differential.sh` against tsc 7.0.2: 2131 tsc / 2128 ours, 0 false positives, 3 misses.
  The TS7 ratchet (`node tests/ts7/run.mjs`): 10209 passing, 0 lost. `zig build test` passes.
- `mise exec node -- pnpm run ci` exit 0 (10m20s): typecheck and lint clean, dupes 88 clones
  (baseline unchanged), unit 63 files / 817 tests passed, subset 1039 fixtures (1008 passed,
  31 expected-fail, 0 failed), golden 516/516, selfhost std 10/10 and node 23/23, leak plateau,
  asan golden 516/516.
