// @mode: js
// @verdict: dynamic
// SUBSET.md: String exotic index
// A string index is the exotic-index arm of `jsrt_get_prop` (plan-notes 375 / F1).
function at(a, i) {
  return a[i];
}
console.log(at('ab', 0));
