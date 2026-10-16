// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Generics — a generic arrow held in a `let` has no home to specialize
// under: reassignment could change the value under a collected tuple (plan.md §8
// step 12(f); js twin of subset_generic_homeless_let_ts.ts — a `.ts`-syntax
// fixture, since `.js` cannot spell a type parameter).

function run(f: (x: number) => number, v: number): number {
  return f(v);
}
let g = <T,>(x: T): T => x;
console.log(run(g, 1));
export {};
