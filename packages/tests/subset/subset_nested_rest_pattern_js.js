// @mode: js
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Array rest PATTERN lands in T29. js mode is dynamic: an untyped array's element type
// is Unknown and `slice` answers the same.

const arr = [1, 2, 3];
const [...[a, ...more]] = arr;
export { a, more };
