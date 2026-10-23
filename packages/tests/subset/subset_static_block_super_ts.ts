// @mode: ts
// @verdict: static
// SUBSET.md: Static methods and static class members (plan.md §8 step 12(d)).
// `super.x` in a static block names a static of the base class — lexically bound,
// so erasure to the base's static binding is exact. A base INSTANCE method stays
// refused (no receiver); bare `super` is a JavaScript SyntaxError.

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
