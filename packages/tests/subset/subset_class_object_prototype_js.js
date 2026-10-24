// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Class-object reads -- `C.prototype` stays not-yet with the named Phase-8 code
// ("the prototype surface"). Same source as subset_class_object_prototype_ts.

class C {
  x = 1;
}
const K = C;
console.log(K.prototype);
