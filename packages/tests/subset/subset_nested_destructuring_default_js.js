// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Nested destructuring
// Default-in-pattern stays not-yet (H1 residue); the diagnostic names it precisely.

const o = {};
const { a = 1 } = o;
export { a };
