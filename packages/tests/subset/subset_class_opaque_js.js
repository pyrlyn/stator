// @mode: js
// @verdict: dynamic
// SUBSET.md: Classes -- a class declaration used as a value (`f(C)`) is its one class object
// (docs/VALUE.md §4.26, T27). In-place uses (`new C`, `C.static`, `o instanceof C`,
// `extends C`) still erase to the declaration.

class C {
  constructor() {
    this.x = 1;
  }
}
function take(v) {
  console.log(v);
}
take(C);
