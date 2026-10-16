// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Generics — a generic arrow passed to `new` has no single parameter
// type to read: `inlineGenericTuple` pairs call arguments only (plan.md §8
// step 12(f); ts twin of subset_generic_homeless_ctor_arg_js.ts).

class Box {
  constructor(f: (x: number) => number) {
    console.log(f(1));
  }
}
new Box(<T,>(x: T): T => x);
