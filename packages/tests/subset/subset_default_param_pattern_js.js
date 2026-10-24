// @mode: js
// @verdict: dynamic
// SUBSET.md: Object destructuring
// A default inside a parameter pattern lands in I1. js mode is dynamic (optional
// property forces the shape table).

function f({ k = 2 }) {
  return k;
}
export { f };
