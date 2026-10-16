// @mode: js
// @verdict: dynamic
// SUBSET.md: Map / Set
// `new Map(iterable)` / `new Set(iterable)` over any iterable, an untyped one included
// (plan.md §11c T11.4 step 6; docs/VALUE.md §4.25).
function build(entries, values) {
  return [new Map(entries), new Set(values)];
}
const [m, s] = build(Object.entries({ a: 1 }), 'abc');
console.log(m.get('a'), s.size);
