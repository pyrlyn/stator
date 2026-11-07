// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Class-object reads -- an unrelated class where another is expected: TypeScript
// accepts `K = E` for any `E` of the same shape, but `new K()` would then build E's layout
// where every read assumes C's (T27). A subclass flows in (subset_class_opaque_*).

class C {
  x: number = 1;
}
class E {
  x: number = 2;
}
let K = C;
K = E;
console.log(new K().x);
