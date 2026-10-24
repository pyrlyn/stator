// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Class inheritance and `super(...)`
// A constructor's `return e` makes `new` yield `e` when it is an object (Node: `new C()`
// answers the returned `{a: 1}`), but this subset's `new` yields the allocated object and
// ignores what a constructor returns (`codegen/`). Accepting one would compile a
// program that silently answers differently, so the value return stays refused — base
// constructors included (plan.md §8 step 12(d)). A bare `return;` is a different rule
// (subset_ctor_return_before_super_*).

class C {
  constructor() {
    const o = { a: 1 };
    return o;
  }
}
export const x = 1;
