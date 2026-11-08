// T29: the shapes the card names, each compiled and checked against Node.
const arr = [1, 2, 3];
const [...[a, b]] = arr;
console.log(a, b);
const [first, ...[second, ...others]] = arr;
console.log(first, second, others.length);
const xs = { items: [10, 20, 30] };
const { items: [...[head]] } = xs;
console.log(head);
const o = { a: 1, b: "x" };
const { ["b"]: viaLiteral } = o;
const k = "a";
const { [k]: viaConst } = o;
console.log(viaLiteral, viaConst);
function g({ k, ...more }) {
  return more;
}
const more = g({ k: 1, m: 2, n: "z" });
console.log(more.m, more.n, Object.keys(more).length);
const deep = { p: { q: 1, r: 2, s: 3 } };
const { p: { q, ...pRest } } = deep;
console.log(q, pRest.r, pRest.s);
