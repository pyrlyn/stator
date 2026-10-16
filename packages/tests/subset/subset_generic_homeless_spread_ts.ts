// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Generics — a generic arrow spread into a call has no single parameter
// type to read: the tuple element carries no parameter position (plan.md §8
// step 12(f); ts twin of subset_generic_homeless_spread_js.ts).

function run(f: (x: number) => number, v: number): number {
  return f(v);
}
const args: [(x: number) => number, number] = [<T,>(x: T): T => x, 1];
console.log(run(...args));
