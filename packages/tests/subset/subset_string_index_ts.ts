// @mode: ts
// @verdict: dynamic
// SUBSET.md: string exotic index
// A string's exotic index on a typed string: `s[0]` answers the UTF-16 unit at that
// position, `undefined` past the end (ECMA-262 §10.4.3; plan-notes 372). The read is
// `string | undefined` under `noUncheckedIndexedAccess`, so it is dynamic exactly as an
// array index read is.

function at(a: string, i: number) {
  return a[i];
}
console.log(at("hello", 0));
console.log(at("hello", 5));
