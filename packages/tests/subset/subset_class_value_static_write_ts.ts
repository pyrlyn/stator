// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Class-object reads -- a static WRITE through a class value: `k.count = 1` with
// `k` holding a subclass makes the subclass's own property, which the shared static binding
// cannot hold (T27). Reads through the value compile (subset_class_value_static_read_*).

class C {
  static count = 0;
}
class D extends C {}
function bump(k: typeof C): void {
  k.count = 1;
}
bump(D);
console.log(C.count, D.count);
