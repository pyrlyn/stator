// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Static methods and static class members (plan.md §8 step 12(d)).
// A static block runs at class-definition time against the statics (plain bindings),
// with no receiver and no class object: `this` there would read the class object,
// which does not exist here (gateThis in gate.ts). Accepted blocks touch statics
// through the class name (subset_static_block_ts).

class C {
  static n = 1;
  static {
    this.n = 2;
  }
}
export const x = C.n;