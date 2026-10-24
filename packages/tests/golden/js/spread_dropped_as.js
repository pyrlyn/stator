// A dropped `as` assertion's unknown operand in an object-literal spread (plan.md §8 step
// 12(c) residue): the assertion names a shape the value need not have, so the result takes
// the dynamic path and `assign` copies what the run-time value holds. The array twin folds
// the same way.

const o = JSON.parse('{"x": 1, "y": 2}');
console.log({ ...(o) });
console.log({ ...(o), z: 3 });
console.log({ z: 3, ...(o) });
console.log({ ...(o), x: 9 });

const a = JSON.parse('[1, 2]');
console.log([...(a)]);
console.log([...(a), 3]);

const n = JSON.parse('null');
console.log({ ...(n) });
const s = JSON.parse('"hi"');
console.log({ ...(s) });
