// @mode: js
// @verdict: dynamic
// SUBSET.md: string exotic index
// A string's exotic index: `s[0]` answers the UTF-16 unit at that position, `undefined`
// past the end (ECMA-262 §10.4.3). Through an Unknown receiver this is `jsrt_get_prop`'s
// string arm; the same spelling on a typed string is the same entry (plan-notes 372).

function at(a, i) {
  return a[i];
}
console.log(at("hello", 0));
console.log(at("hello", 5));
