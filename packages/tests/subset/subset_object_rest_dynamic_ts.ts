// @mode: ts
// @verdict: dynamic
// SUBSET.md: Object destructuring
// Object rest over a dynamic/unknown source lands in T29: the remainder copies through
// the shape table (`Object.assign` + `delete` of the bound keys), the spread twin.

const o: { a?: number; b: number } = { b: 1 };
const { a, ...rest } = o;
export { rest };
