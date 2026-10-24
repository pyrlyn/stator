// @mode: ts
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Default-in-pattern lands in I1 (step 12a remainder): the default runs when the
// read is `undefined`, like a parameter's.

const o: { a?: number } = {};
const { a = 1 } = o;
export { a };
