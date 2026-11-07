// A method read off a dynamic object keeps `this` and every argument when the call passes more or
// fewer arguments than its `length`, and the same method called bare takes no receiver
// (plan-notes 395).
const o = {
  k: 100,
  add(a, b = 1) {
    return this.k + a + b;
  },
  all(...xs) {
    return `${this.k}:${xs.join(',')}`;
  },
  get twice() {
    return this.k * 2;
  },
  set twice(v) {
    this.k = v / 2;
  },
};
console.log(o.add(1), o.add(1, 2), o.add(1, 2, 3));
console.log(o.all(), o.all(1), o.all(1, 2, 3));
o.twice += 2;
console.log(o.k, o.twice);
const all = o.all;
console.log([1, 2].map((x) => all.call(o, x, x)).join(' '));
const add = o.add;
console.log([3, 4].map((x) => add.call(o, x)).join(' '));
