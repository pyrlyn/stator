// @mode: js
// @verdict: static
// SUBSET.md: Class-object reads -- `C.name` / `K.name` folds to Node's display name
// (docs/VALUE.md §4.26, T27 narrow slice). Same source as subset_class_object_name_ts.

class C {
  x = 1;
  static s = 5;
}
const K = C;
console.log(K.name);
console.log(C.name);
console.log(K.s);
