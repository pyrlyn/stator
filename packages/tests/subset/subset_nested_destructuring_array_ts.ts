// @mode: ts
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Nested array patterns in declarations and parameters (H1).

const arr: [number[], [number]] = [[1], [2]];
const [x, [y]] = arr;
export function f([a, [b]]: [number[], [number]]): number {
  return b;
}
export { x, y };
