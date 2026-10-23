// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Static methods and static class members
// `this` in a static METHOD is whoever the method was reached through — `T.m()` reads
// `T.v`, `S.m()` reads `S.v` — which needs the class object. The narrow erasure is
// exact only in a static FIELD initializer or BLOCK, where `this` is the class being
// defined (subset_static_block_this_*).

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
