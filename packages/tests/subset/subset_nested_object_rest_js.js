// @mode: js
// @verdict: static
// SUBSET.md: Nested destructuring
// Nested object rest lands in I1. js mode is dynamic: no fixed layout.

const o = { a: { u: 1, v: "z" } };
const { a: { ...r } } = o;
export { r };
