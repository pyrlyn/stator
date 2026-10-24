const o = { a: 1, b: "x", c: true };
const { a, ...rest } = o;
console.log(a);
console.log(rest.b);
console.log(rest.c);
const arr = [1, 2, 3, 4];
const [x, ...tail] = arr;
console.log(x);
console.log(tail.length);
console.log(tail[0]);
console.log(tail[1]);
const p = {};
const { n = 7 } = p;
console.log(n);
const q = { n: 3 };
const { n: n2 = 7 } = q;
console.log(n2);
function f({ k = 2 }) {
  return k;
}
console.log(f({}));
console.log(f({ k: 9 }));
const nested = {
  inner: { u: 1, v: "z", w: false },
};
const { inner: { u, ...more } } = nested;
console.log(u);
console.log(more.v);
console.log(more.w);
const withDef = {};
const { q: { deep } = { deep: 5 } } = withDef;
console.log(deep);
const nums = [undefined, 2];
const [d1 = 1, d2 = 3] = nums;
console.log(d1);
console.log(d2);
const xs = { items: [10, 20, 30] };
const { items: [head, ...itemsRest] } = xs;
console.log(head);
console.log(itemsRest.length);
console.log(itemsRest[0]);
console.log(itemsRest[1]);
