// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Class inheritance and `super(...)`
// The js-mode twin: `new` yields the allocated object and ignores what a constructor
// returns (`codegen/`), where Node substitutes a returned object — so a constructor
// value return stays refused (plan.md §8 step 12(d)).

class C {
  constructor() {
    const o = { a: 1 };
    return o;
  }
}
export const x = 1;
