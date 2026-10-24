// @mode: js
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Nested array patterns in declarations and parameters (H1).

const arr = [[1], [2]];
const [x, [y]] = arr;
export function f([a, [b]]) {
  return b;
}
export { x, y };
