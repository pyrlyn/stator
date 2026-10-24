// @mode: ts
// @verdict: static
// SUBSET.md: Generics — a generic arrow held in a `let` specializes under a position-derived key when its only write is the initializer
// (docs/HIR.md §7.2); ts twin of subset_generic_homeless_let_js.ts).

function run(f: (x: number) => number, v: number): number {
  return f(v);
}
let g = <T,>(x: T): T => x;
console.log(run(g, 1));
