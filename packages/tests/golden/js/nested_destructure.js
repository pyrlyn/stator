const o = { a: { b: 1 }, c: [2, 3] };
const { a: { b }, c: [d] } = o;
console.log(b);
console.log(d);
const nested = { x: { y: { z: 4 } } };
const { x: { y: { z } } } = nested;
console.log(z);
function f([p, [q]]) {
  return q;
}
console.log(f([5, [6]]));
