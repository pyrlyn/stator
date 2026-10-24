// @mode: js
// @verdict: static
// SUBSET.md: Nested destructuring
// Nested object/array patterns land in H1 (step 12a residue).

const o = { a: { b: 1 } };
const { a: { b } } = o;
export { b };
