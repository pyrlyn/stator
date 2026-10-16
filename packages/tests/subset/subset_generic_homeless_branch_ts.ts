// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Generics — a generic arrow in a branch has no single parameter type to
// read: the conditional is not a direct call argument (plan.md §8 step 12(f);
// ts twin of subset_generic_homeless_branch_js.ts).

function run(f: (x: number) => number, v: number): number {
  return f(v);
}
console.log(run(1 > 0 ? <T,>(x: T): T => x : (x: number) => x + 1, 1));
