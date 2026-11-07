// @mode: js
// @verdict: dynamic
// SUBSET.md: Class-object reads -- a static WRITE through a class value: `k.count = 1` with
// `k` holding a subclass makes the subclass's own property, which the shared static binding
// cannot hold (T27). Reads through the value compile (subset_class_value_static_read_*).
// In js mode `k` is untyped, so the write compiles to the shape-table store, and the runtime
// refuses the inherited-static write with STA2004 instead of updating `C.count`.

class C {
  static count = 0;
}
class D extends C {}
function bump(k) {
  k.count = 1;
}
bump(D);
console.log(C.count, D.count);
