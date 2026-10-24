// @mode: js
// @verdict: dynamic
// SUBSET.md: Object destructuring
// Object rest over an untyped source lands in T29: the remainder copies through the
// shape table, the spread twin. js mode is dynamic because the source has no layout.

function g({ k, ...more }) {
  return more;
}
export { g };
