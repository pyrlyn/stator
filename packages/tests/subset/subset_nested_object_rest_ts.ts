// @mode: ts
// @verdict: static
// SUBSET.md: Nested destructuring
// Nested object rest (`const { a: { ...r } } = o`) lands in I1: the inner pattern's
// rest copies the nested source's remaining fields.

const o: { a: { u: number; v: string } } = { a: { u: 1, v: "z" } };
const { a: { ...r } } = o;
export { r };
