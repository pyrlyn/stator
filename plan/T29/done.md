# T29. Done

The three steps landed in #192 (`8910b97c`, plan-notes 383):
- A rest PATTERN destructures the slice further.
- A computed key with a statically known name takes a slot (step 22's rule, in `docs/SUBSET.md`).
- Object rest over a dynamic or unknown source copies through the shape table, the spread twin.

This change adds the evidence the Check asks for:

- Golden `destructure_rest_pattern` in both modes (`packages/tests/golden/ts/…ts`, `…/js/…js`). It covers:
  - `[...[a, b]]` and `[first, ...[second, ...others]]`.
  - `{ items: [...[head]] }`.
  - `{ ["b"]: v }` and `{ [k]: v }` with `const k = "a"`.
  - Object rest over an optional-field source (ts) or an untyped parameter (js).
  - Nested object rest.
- `docs/SUBSET.md`: the Array destructuring row no longer lists a rest PATTERN as `not-yet`.

## Check

- Subset rows: `subset_nested_destructuring_*` and `subset_nested_rest_*` (plus `subset_nested_object_rest_*`, `subset_object_rest_dynamic_ts`, `subset_object_rest_untyped_js` and `subset_destructure_computed_static_*`) are all `static` or `dynamic`, and none carries `@expected-fail`. `pnpm run test:subset`: `subset: 1039 fixtures — 1008 passed, 31 expected-fail, 0 failed`.
- Goldens: `pnpm run test:golden`: `golden: 518 fixtures — 518 passed, 0 failed`. Both new fixtures also match `node` output byte for byte by `cmp`.
- Still-refused shapes name their construct:
  - "a computed key with a runtime name in a destructuring declaration / parameter / pattern is not yet supported" (`gate.ts`, `lower/index.ts`).
  - "an object rest over a type with methods is not yet supported".
  - "an object rest over a value with no fixed layout is not yet supported".
- `pnpm run ci` passes: every step from `dupes` through `test:asan`. Lint was run as `oxlint --deny-warnings .` plus `oxfmt --check` over tracked files, because a local untracked harness file (`.claude/settings.local.json`) fails the glob.
