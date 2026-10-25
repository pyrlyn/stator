// @mode: js
// @verdict: dynamic
// SUBSET.md: Spread operator ... in array literals / Object literals with static keys
// An `as` assertion to an array or object type is never checkable (only number, string and
// boolean are), so the lowering drops it and spreads the unknown operand. The object case
// takes the dynamic path through the shape-table `assign` (plan-notes 297); the array case
// folds the same way (plan.md §8 step 12(c) residue).

const u: unknown = JSON.parse('[1, 2]');
export const a = [...(u as number[])];
const o: unknown = JSON.parse('{"x": 1}');
export const b = { ...(o as { x: number }) };
console.log(a);
console.log(b);
