// @mode: ts
// @verdict: static
// SUBSET.md: Class-object reads -- `C.name` / `K.name` folds to Node's display name
// (docs/VALUE.md §4.26, T27 narrow slice). No class object is built; statics through the
// alias are the existing binding erasure.

class C {
  x: number = 1;
  static s: number = 5;
}
const K = C;
console.log(K.name);
console.log(C.name);
console.log(K.s);
