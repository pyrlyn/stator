// T34: `bind` with partial arguments -- bound ones come first and a second bind appends.
function add3(a: number, b: number, c: number): number {
  return a * 100 + b * 10 + c;
}
const add1 = add3.bind(undefined, 1);
const add12 = add1.bind(null, 2);
console.log(add1(2, 3), add12(4), add3.bind(null, 1, 2, 3)());
console.log([1, 2, 3].map(add3.bind(undefined, 7, 8)));
const twice = (x: number): number => x * 2;
console.log(twice.bind(null)(21), twice.bind(null, 4)());
console.log(add1.call(undefined, 5, 6), add1.apply(undefined, [7, 8]));
