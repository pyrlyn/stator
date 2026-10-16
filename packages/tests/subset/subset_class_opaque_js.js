// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Classes -- an opaque class-declaration use (`f(C)`) reads the class object,
// which does not exist (plan.md §8 step 12e). In-place uses (`new C`, `C.static`,
// `o instanceof C`, `extends C`) erase to the declaration and compile.

class C {
  constructor() {
    this.x = 1;
  }
}
function take(v) {
  console.log(v);
}
take(C);
