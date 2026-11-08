// T34: `bind` with partial arguments -- bound ones come first, a second bind appends, and
// `length` drops by the count bound.
function add3(a, b, c) {
  return a * 100 + b * 10 + c;
}
const add1 = add3.bind(undefined, 1);
const add12 = add1.bind(null, 2);
console.log(add1(2, 3), add12(4), add12(5, 6));
console.log(add3.length, add1.length, add12.length, add3.bind(null, 1, 2, 3, 4).length);
console.log(add1.name, add12.name);
console.log([1, 2, 3].map(add3.bind(undefined, 7, 8)));
const twice = (x) => x * 2;
console.log(twice.bind(null)(21), twice.bind(null, 4)());
console.log(add1.call(undefined, 5, 6), add1.apply(undefined, [7, 8]));
