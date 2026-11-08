// @mode: ts
// @verdict: static
// SUBSET.md: Static methods and static class members
// `super.m()` in a static is lexically bound to the base, so the CALL erases; the base
// method's `this` is still the reached-through class (`B.m()` sees `B`, `D.m()` sees `D`),
// which the call passes as the receiver (plan.md T27 step 4).

class B {
  static id = 'B';
  static m(): string {
    return `B:${this.id}`;
  }
}
class D extends B {
  static override id = 'D';
  static override m(): string {
    return `D>${super.m()}`;
  }
}
console.log(D.m());
