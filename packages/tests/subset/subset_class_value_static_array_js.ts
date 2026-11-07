// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Class-object reads -- a static of a type with no O(1) check, read through a class
// value: the read is `unknown` until it narrows, and an array cannot be checked there (T27).
// Primitive statics compile (subset_class_value_static_read_*).

class C {
  static xs: number[] = [1, 2];
}
function count(k: typeof C): number {
  return k.xs.length;
}
console.log(count(C));
