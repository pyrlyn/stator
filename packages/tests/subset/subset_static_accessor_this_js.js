// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Static methods and static class members
// `this` in a static ACCESSOR a subclass can reach (`T.v` runs the getter with `this = T`)
// stays refused: T27 step 4 passes the reached-through class to static METHODS only.

class S {
  static base = 1;
  static get v() {
    return this.base;
  }
}
class T extends S {
  static base = 2;
}
console.log(S.v, T.v);
