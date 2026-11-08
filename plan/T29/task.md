---
status: in progress
priority: P2
complexity: 2
readiness: 100%
agent: Claude Code / claude-opus-5-5
---

# T29. Nested rest-patterns and defaults beyond one level

Step 12a remainder after plan-notes 379/380. `isSimpleBindingPattern` accepts nested
object/array + rest + defaults at any depth; still refused precisely: a rest *pattern*
(`...{a}` / `...[a]`), a computed key in a pattern, object rest over a no-fixed-layout value.

Steps:
1. Land rest-pattern (`const { a: { ...r } } = o` already landed as object rest; the remainder
   is array/object **rest elements inside nested patterns** and rest-pattern as a whole).
2. Computed keys in binding patterns (`const { [k]: v } = o`) — decide static-key only or
   dynamic; write it in `docs/SUBSET.md`.
3. Object rest over a dynamic/unknown source: route through the shape table (the spread twin).

**Check:** `subset_nested_destructuring_*` and new `subset_nested_rest_*` rows are `static` or
`dynamic` (not `expected-fail`) for every shape this card names; goldens match Node; any
still-refused shape has a message naming the construct.

## Execution plan

The three steps landed in #192 (plan-notes 383). What is left is evidence.

1. Confirm every subset row the card names is `static` or `dynamic` and none is
   `expected-fail`: `pnpm run test:subset`.
2. Add golden `destructure_rest_pattern` in both modes. It covers the array rest pattern,
   nested at depth, a static computed key, object rest over an optional-field source and over an
   untyped parameter, and nested object rest. Then `pnpm run test:golden`.
3. Check that each still-refused shape names its construct (`gate.ts`, `lower/index.ts`).
4. Remove the stale "rest PATTERN not-yet" from the Array destructuring row in
   `docs/SUBSET.md`.
5. Run `pnpm run ci`, then write `done.md`.
