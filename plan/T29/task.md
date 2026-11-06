---
status: todo
priority: P2
complexity: 2
readiness: 100%
agent:
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
