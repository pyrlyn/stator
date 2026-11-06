// @mode: ts
// @verdict: static
// SUBSET.md: Classes -- a class alias read as a value is the class object it names
// (docs/VALUE.md §4.26, T27): `console.log(K)` prints the class. In-place uses (`new K`,
// `K.static`, `o instanceof K`) still erase to the target declaration.

class C {
  x: number = 1;
}
const K = C;
console.log(K);
