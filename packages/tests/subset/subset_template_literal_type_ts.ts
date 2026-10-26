// @mode: ts
// @verdict: static
// SUBSET.md: a template literal type is a string

type Amount = `${number}ms`;
function amount(n: number): Amount {
  return `${n}ms`;
}
const a: Amount = amount(5);
console.log(`${a}!`, a.length);
