// @mode: ts
// @verdict: dynamic
// SUBSET.md: Nested destructuring
// Array rest PATTERN (`const [...[a]] = arr`) lands in T29: the slice is destructured
// further rather than bound as one name. Array destructuring is dynamic (the existing
// array-destructuring verdict). (An object rest PATTERN `...{ a }` is a TypeScript parse
// error — the parser only accepts `... BindingIdentifier` there — so that shape never
// reaches the gate.)

const arr: number[] = [1, 2, 3];
const [...[a]] = arr;
export { a };
