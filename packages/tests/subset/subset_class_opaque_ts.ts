// @mode: ts
// @verdict: dynamic
// SUBSET.md: Classes -- a class declaration used as a value (`f(C)`) is its one class object
// (docs/VALUE.md §4.26, T27); the `unknown` parameter is what makes the verdict dynamic.
// In-place uses (`new C`, `C.static`, `o instanceof C`, `extends C`) still erase.

class C {
  x: number = 1;
}
function take(v: unknown): unknown {
  return v;
}
console.log(take(C) === C);
