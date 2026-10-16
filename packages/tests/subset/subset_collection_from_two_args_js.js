// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Map / Set
// One fixed-arity runtime row per constructor: a spread argument is refused (plan.md §11c T11.4
// step 6).
const pairs = [[['a', 1]]];
const m = new Map(...pairs);
console.log(m.size);
