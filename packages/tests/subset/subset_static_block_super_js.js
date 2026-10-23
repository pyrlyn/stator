// @mode: js
// @verdict: static
// SUBSET.md: Static methods and static class members (plan.md §8 step 12(d)).
// Same rule as subset_static_block_super_ts: `super.x` in a static block names a
// static of the base and erases to its binding.

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
export const y = B.n;
