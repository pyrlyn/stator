// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Static methods and static class members (plan.md §8 step 12(d)).
// Same refusal as subset_static_block_super_ts: `super` in a static block has no
// receiver to resolve the base through.

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