// @mode: ts
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Rest-in-pattern lands in I1 (step 12a remainder): `...rest` binds `a.slice(i)`.

const arr: number[] = [1, 2, 3];
const [a, ...rest] = arr;
export { a, rest };
