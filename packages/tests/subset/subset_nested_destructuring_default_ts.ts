// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Nested destructuring
// Default-in-pattern stays not-yet (H1 residue); the diagnostic names it precisely.

const o: { a?: number } = {};
const { a = 1 } = o;
export { a };
