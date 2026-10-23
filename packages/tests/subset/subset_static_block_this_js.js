// @mode: js
// @verdict: static
// SUBSET.md: Static methods and static class members (plan.md §8 step 12(d)).
// Same rule as subset_static_block_this_ts: `this.x` in a static block names the
// class being defined and erases to its static binding.

class C {
  static n = 1;
  static {
    this.n = 2;
  }
}
export const x = C.n;
