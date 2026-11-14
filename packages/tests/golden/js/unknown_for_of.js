// for-of over an unknown iterable (plan.md §8 step 2a(c)): runtime GetIterator dispatch.

function sum(xs) {
  let t = 0;
  for (const x of xs) {
    t = t + x;
  }
  return t;
}

function* count(n) {
  let i = 0;
  while (i < n) {
    yield i;
    i = i + 1;
  }
}

class Counter {
  constructor(n) {
    this.n = n;
  }
  [Symbol.iterator]() {
    return count(this.n);
  }
}

console.log(sum([1, 2, 3]));
console.log(sum(new Counter(3)));
