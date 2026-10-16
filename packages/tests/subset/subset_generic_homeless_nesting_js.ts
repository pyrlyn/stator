// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Generics — a generic arrow under a nesting has no home to specialize
// under: a nested `const` lives in a scope the module-level specializations would
// leak (plan.md §8 step 12(f); js twin of subset_generic_homeless_nesting_ts.ts —
// a `.ts`-syntax fixture, since `.js` cannot spell a type parameter).

function run(f: (x: number) => number, v: number): number {
  return f(v);
}
function outer(): number {
  const g = <T,>(x: T): T => x;
  return run(g, 1);
}
console.log(outer());
export {};
