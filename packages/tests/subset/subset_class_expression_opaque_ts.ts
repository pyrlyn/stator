// @mode: ts
// @verdict: dynamic
// SUBSET.md: Classes -- a bound class expression read as a value is its one class object
// (docs/VALUE.md §4.26, T27); the `unknown` parameter is what makes the verdict dynamic.
// In-place uses (`new C`, `C.static`, `o instanceof C`, `extends C`) still erase.

const C = class {
  m(): number {
    return 7;
  }
};
export function take(x: unknown): unknown {
  return x;
}
export const y = take(C);
