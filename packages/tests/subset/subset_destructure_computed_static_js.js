// @mode: js
// @verdict: static
// SUBSET.md: Object destructuring
// A computed key with a static name lands in T29. An untyped object literal is still a
// fixed layout when every field is required, so the read is static.

const k = "a";
const o = { a: 1, b: "x" };
const { [k]: v } = o;
export { v };
