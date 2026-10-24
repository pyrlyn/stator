// @mode: ts
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Mixed object/array nesting (H1).

const o: { a: [number, number] } = { a: [1, 2] };
const { a: [b, c] } = o;
export { b, c };
