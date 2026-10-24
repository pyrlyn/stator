// @mode: js
// @verdict: static
// SUBSET.md: Class-object reads -- `typeof C` / `typeof K` folds to `"function"` beside
// `C.name` (docs/VALUE.md §4.26, T27). No class object is built. `C.prototype` and the
// opaque value surface (`f(C)`, `console.log(K)`) stay not-yet.

class C {
  constructor() {
    this.x = 1;
  }
}
const K = C;
console.log(typeof C);
console.log(typeof K);
const Expr = class Inner {
  m() {
    return 1;
  }
};
console.log(typeof Expr);
