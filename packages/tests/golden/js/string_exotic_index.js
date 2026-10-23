// String exotic index through an Unknown receiver and a typed string (F1).
function first(a) {
  return a[0];
}
function at(a, i) {
  return a[i];
}
const s = 'ab';
console.log(first(s));
console.log(at(s, 1));
console.log(at(s, 2));
console.log(at(s, 0));
console.log(s['0']);
console.log(s['01']);
console.log(s['4.0']);
