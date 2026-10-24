// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Nested destructuring
// Rest-in-pattern stays not-yet (H1 residue); the diagnostic names it precisely.

const arr: number[] = [1, 2, 3];
const [a, ...rest] = arr;
export { a, rest };
