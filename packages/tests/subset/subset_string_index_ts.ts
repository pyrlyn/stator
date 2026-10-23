// @mode: ts
// @verdict: dynamic
// SUBSET.md: String exotic index
// `s[i]` is `string | undefined` under noUncheckedIndexedAccess, so the read is dynamic.
function at(a: string, i: number): string | undefined {
  return a[i];
}
console.log(at('ab', 0));
