// @mode: js
// @verdict: static
// SUBSET.md: Generics — a nested `const` holding a generic arrow is block-homed and
// specializes under a position-derived key (docs/HIR.md §7).

function run(f: (x: number) => number, v: number): number {
  return f(v);
}
function outer(): number {
  const g = <T,>(x: T): T => x;
  return run(g, 1);
}
console.log(outer());
