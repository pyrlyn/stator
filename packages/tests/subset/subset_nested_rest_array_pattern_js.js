// @mode: js
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Array rest PATTERN nested in an object pattern lands in T29. js mode is dynamic: an
// untyped array's element type is Unknown and `slice` answers the same.

const xs = { items: [10, 20, 30] };
const { items: [...[head, ...tail]] } = xs;
export { head, tail };
