// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Object destructuring
// A computed key with a RUNTIME name stays not-yet (T29): the field the pattern reads is
// not known until run time. The diagnostic names it precisely.

declare const k: string;
const o: { a: number } = { a: 1 };
const { [k]: v } = o;
export { v };
