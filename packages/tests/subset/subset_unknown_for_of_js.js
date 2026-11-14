// @mode: js
// @verdict: dynamic
// SUBSET.md: for-of over an unknown iterable uses runtime GetIterator (plan.md §8 step 2a(c))

function sum(xs) {
  let t = 0;
  for (const x of xs) {
    t = t + x;
  }
  return t;
}
console.log(sum([1, 2, 3]));
