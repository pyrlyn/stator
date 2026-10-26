// @mode: ts
// @verdict: static
// SUBSET.md: Generics — a block-homed `const` holding a generic arrow specializes under a
// position-derived key (`name@file#offset`, docs/HIR.md §7). The body must not capture
// enclosing scope; this one does not.

function run(f: (x: number) => number, v: number): number {
  return f(v);
}
function outer(): number {
  const g = <T,>(x: T): T => x;
  return run(g, 1);
}
console.log(outer());
