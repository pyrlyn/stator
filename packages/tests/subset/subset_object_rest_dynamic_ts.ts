// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Object destructuring
// Object rest over a value with no fixed layout stays not-yet (I1 residue); the
// diagnostic names it precisely.

const o: { a?: number; b: number } = { b: 1 };
const { a, ...rest } = o;
export { rest };
