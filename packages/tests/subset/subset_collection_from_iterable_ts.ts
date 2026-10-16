// @mode: ts
// @verdict: static
// SUBSET.md: Map / Set
// `new Set(values)` and `new Map(map)` with one iterable argument drain it through the iterator
// protocol in the runtime (plan.md §11c T11.4 step 6; docs/VALUE.md §4.25). `new Map(entries)`
// over an array literal of pairs is dynamic only because a mixed tuple is.
const m = new Map<string, number>();
m.set('a', 1);
const copy = new Map(m);
const s = new Set(['x', 'y', 'x']);
const keys = new Set(m.keys());
console.log(copy.has('a'), copy.size, s.size, keys.has('a'));
