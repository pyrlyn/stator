// @mode: js
// @verdict: dynamic
// SUBSET.md: Classes -- a bound class expression read as a value is its one class object
// (docs/VALUE.md §4.26, T27). In-place uses (`new C`, `C.static`, `o instanceof C`,
// `extends C`) still erase to the expression (subset_class_expression_js).

const C = class {
  m() {
    return 7;
  }
};
export function take(x) {
  return x;
}
export const y = take(C);
