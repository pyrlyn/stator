// @mode: ts
// @verdict: static
// SUBSET.md: Object destructuring
// A computed key with a STATIC name (`const { [k]: v } = o`, `k: "a"`) lands in T29
// under the step-22 rule: it is the name the direct spelling writes.

const k = "a";
const o: { a: number; b: string } = { a: 1, b: "x" };
const { [k]: v } = o;
export { v };
