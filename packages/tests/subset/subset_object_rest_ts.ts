// @mode: ts
// @verdict: static
// SUBSET.md: Object destructuring
// Object rest lands in I1: `...rest` binds a fresh object of the remaining fields.

const o: { a: number; b: string; c: boolean } = { a: 1, b: "x", c: true };
const { a, ...rest } = o;
export { a, rest };
