// @mode: js
// @verdict: static
// SUBSET.md: Object destructuring
// Object rest lands in I1. js mode is dynamic: an untyped source has no fixed layout.

const o = { a: 1, b: "x", c: true };
const { a, ...rest } = o;
export { a, rest };
