// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Static methods and static class members (plan.md §8 step 12(d)).
// A static block runs against the statics with no receiver for a base to resolve
// through: `super` in a block would read the class object through a base it has no
// receiver for (gate.ts static-block arm). Accepted blocks touch statics through
// the class name (subset_static_block_ts).

class B {
  static n = 1;
}
class D extends B {
  static s = 0;
  static {
    D.s = 5;
    super.n = 6;
  }
}
export const x = D.s;