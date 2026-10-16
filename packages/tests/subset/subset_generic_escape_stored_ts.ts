// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Generics — a generic that escapes (here, stored in an array) has no
// call site to name a tuple by: aliases specialize at direct calls and at
// function-typed parameters, and anything further out waits on the dynamic tier
// (plan.md §8 step 12(f); ts twin of subset_generic_escape_stored_js.ts).

function box<T>(x: T): T {
  return x;
}
const fns: Array<(x: number) => number> = [box];
console.log(fns.length);
