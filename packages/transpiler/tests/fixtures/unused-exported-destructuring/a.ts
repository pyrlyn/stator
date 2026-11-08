// Bindings of an exported destructuring are exported, so none of them is unused.
const source = { a: 1, b: "", c: true, d: 2 };
export const { a, b } = source;
export const [x, y] = [1, 2];
const { c, d } = source;
