// @mode: ts
// @verdict: dynamic
// SUBSET.md: Static methods and static class members
// `this` in a static METHOD is whoever the method was reached through — `T.m()` reads
// `T.v`, `S.m()` reads `S.v` (plan.md T27 step 4). `S` has a subclass, so the call passes
// the class as the receiver and `this.v` reads through it dynamically.

class S {
  static v = 5;
  static m(): number {
    return this.v * 2;
  }
}
class T extends S {
  static override v = 10;
}
console.log(`${S.m()} ${T.m()}`);
