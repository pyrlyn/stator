// @mode: ts
// @verdict: static
// SUBSET.md: Static methods and static class members (plan.md §8 step 12(d)).
// A static block runs at class-definition time with `this` bound to the class being
// defined, so `this.x` naming a static of that class erases to the static binding —
// the same read `C.x` makes. Bare `this` (the class object) stays refused.

class C {
  static n = 1;
  static {
    this.n = 2;
  }
}
export const x = C.n;
