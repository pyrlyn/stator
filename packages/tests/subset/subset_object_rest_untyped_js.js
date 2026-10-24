// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Object destructuring
// Object rest over a value with no fixed layout stays not-yet (I1 residue); the
// diagnostic names it precisely.

function g({ k, ...more }) {
  return more;
}
export { g };
