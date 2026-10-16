// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Static methods and static class members (plan.md §8 step 12(d)).
// Same refusal as subset_static_block_this_ts: a static block has no receiver,
// so `this` would read the class object, which does not exist here.

class C {
  static n = 1;
  static {
    this.n = 2;
  }
}
export const x = C.n;