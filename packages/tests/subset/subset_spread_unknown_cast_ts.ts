// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Spread operator ... in array literals / Object literals with static keys
// An `as` assertion to an array or object type is never checkable (only number, string and
// boolean are), so the lowering drops it and spreads the unknown operand — refused here with
// the unknown-value not-yet instead of reaching the verifier as STA4082/STA4068
// (plan.md §8 step 39; ts twin of subset_spread_unknown_cast_js.ts).

const u: unknown = JSON.parse('[1, 2]');
export const a = [...(u as number[])];
const o: unknown = JSON.parse('{"x": 1}');
export const b = { ...(o as { x: number }) };
console.log(a);
console.log(b);
