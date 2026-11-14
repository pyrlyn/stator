// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: for-of over a plain object without `[Symbol.iterator]()` is still not-yet in ts mode

for (const x of { a: 1 }) {
  console.log(x);
}
