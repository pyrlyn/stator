const o: { a: number; b: string; c: boolean } = { a: 1, b: "x", c: true };
const { a, ...rest } = o;
console.log(a);
console.log(rest.b);
console.log(rest.c);
const arr: number[] = [1, 2, 3, 4];
const [x, ...tail] = arr;
console.log(x);
console.log(tail.length);
console.log(tail[0]);
console.log(tail[1]);
const p: { n?: number } = {};
const { n = 7 } = p;
console.log(n);
const q: { n?: number } = { n: 3 };
const { n: n2 = 7 } = q;
console.log(n2);
function f({ k = 2 }: { k?: number }): number {
  return k;
}
console.log(f({}));
console.log(f({ k: 9 }));
function g({ k, ...more }: { k: number; extra: number }): number {
  return k + more.extra;
}
console.log(g({ k: 2, extra: 10 }));
const nested: { inner: { u: number; v: string; w: boolean } } = {
  inner: { u: 1, v: "z", w: false },
};
const { inner: { u, ...more } } = nested;
console.log(u);
console.log(more.v);
console.log(more.w);
const withDef: { q?: { deep: number } } = {};
const { q: { deep } = { deep: 5 } } = withDef;
console.log(deep);
const nums: (number | undefined)[] = [undefined, 2];
const [d1 = 1, d2 = 3] = nums;
console.log(d1);
console.log(d2);
const xs: { items: number[] } = { items: [10, 20, 30] };
const { items: [head, ...itemsRest] } = xs;
console.log(head);
console.log(itemsRest.length);
console.log(itemsRest[0]);
console.log(itemsRest[1]);
