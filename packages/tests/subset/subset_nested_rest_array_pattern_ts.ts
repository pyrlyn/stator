// @mode: ts
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Array rest PATTERN nested in an object pattern (`const { items: [...[head]] } = xs`)
// lands in T29. Array destructuring is dynamic (the existing array-destructuring verdict).

const xs: { items: number[] } = { items: [10, 20, 30] };
const { items: [...[head]] } = xs;
export { head };
