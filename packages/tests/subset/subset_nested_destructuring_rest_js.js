// @mode: js
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Rest-in-pattern lands in I1 (step 12a remainder). js mode is dynamic because an
// untyped array's element type is Unknown and `slice` answers the same.

const arr = [1, 2, 3];
const [a, ...rest] = arr;
export { a, rest };
