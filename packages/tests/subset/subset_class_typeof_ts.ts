// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Classes -- `typeof C` on a class reads the class object (plan.md §8 step 12e),
// the same value an opaque `f(C)` use reads. `typeof` on any other operand folds.

class C {
  x: number = 1;
}
console.log(typeof C);
