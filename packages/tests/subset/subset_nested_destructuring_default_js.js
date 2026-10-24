// @mode: js
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Default-in-pattern lands in I1 (step 12a remainder). js mode is dynamic because
// the source object has no fixed layout.

const o = {};
const { a = 1 } = o;
export { a };
