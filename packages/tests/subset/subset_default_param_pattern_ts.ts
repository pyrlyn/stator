// @mode: ts
// @verdict: dynamic
// SUBSET.md: Object destructuring
// A default inside a parameter pattern lands in I1.

function f({ k = 2 }: { k?: number }): number {
  return k;
}
export { f };
