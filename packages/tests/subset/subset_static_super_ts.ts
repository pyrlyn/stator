// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Static methods and static class members
// `super.m()` in a static is lexically bound to the base, so the CALL erases — but the
// base method's own `this` is still the reached-through class object (`B.m()` sees `B`,
// `D.m()` sees `D`), which needs the class object (subset_static_this_*).

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
