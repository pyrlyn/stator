// A dropped `as` assertion's unknown operand in an object-literal spread (plan.md §8 step
// 12(c) residue): `o as { x: number }` lowers to the unknown `o`, and the result takes the
// dynamic path through the shape-table `assign` (plan-notes 297). The array twin folds
// the same way.

const o: unknown = JSON.parse('{"x": 1, "y": 2}');
console.log({ ...(o as { x: number }) });
console.log({ ...(o as { x: number }), z: 3 });
console.log({ z: 3, ...(o as { x: number }) });

const a: unknown = JSON.parse('[1, 2]');
console.log([...(a as number[])]);
console.log([...(a as number[]), 3]);
