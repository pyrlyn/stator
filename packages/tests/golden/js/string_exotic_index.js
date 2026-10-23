// String exotic index (ECMA-262 §10.4.3) on an Unknown receiver and on a typed string:
// a canonical array index below length answers the UTF-16 unit, not `undefined`
// (plan-notes 372 residue). Out of range and non-canonical keys stay `undefined`.

function at(a, i) {
  return a[i];
}
console.log(at("hello", 0));
console.log(at("hello", 4));
console.log(at("hello", 5));
console.log(at("hello", "1"));
console.log(at("hello", "01"));
console.log(at("hello", "4.0"));
console.log(at("hello", 1.0));

function key(a, k) {
  return a[k];
}
console.log(key("xy", "0"), key("xy", "1"), key("xy", "2"));

function len(a) {
  return a.length;
}
console.log(len("hello"), len(""));

function hasChar(a, i) {
  return a[i] !== undefined;
}
console.log(hasChar("x", 0), hasChar("x", 1), hasChar("", 0));

const s = "ab";
console.log(s[0], s[1], s[2]);
console.log(s["0"], s["1"]);
