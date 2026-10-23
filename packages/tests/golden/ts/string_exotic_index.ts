// String exotic index (ECMA-262 §10.4.3) on a typed string: a canonical array index
// below length answers the UTF-16 unit, not `undefined` (plan-notes 372 residue).
// Out of range stays `undefined`. The string-key spelling is a checker error under
// noImplicitAny, so this twin is numeric keys only.

function at(a: string, i: number) {
  return a[i];
}
console.log(at("hello", 0));
console.log(at("hello", 4));
console.log(at("hello", 5));

const s: string = "ab";
console.log(s[0], s[1], s[2]);
console.log(s[0] !== undefined, s[2] !== undefined);
