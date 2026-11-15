// Array growth, indexed reads and the callback builtins (map, filter, reduce, sort): the element
// loop runs inside the runtime, so a slow callback trampoline shows here and nowhere else.
let seed: number = 12345;
function next(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed;
}

let checksum: number = 0;
for (let round = 0; round < 40; round += 1) {
  const values: number[] = [];
  for (let i = 0; i < 20_000; i += 1) values.push(next() % 100_000);
  const doubled = values.map((value) => value * 2);
  const even = doubled.filter((value) => value % 4 === 0);
  const sum = even.reduce((acc, value) => acc + value, 0);
  const sorted = values.slice(0, 2000).sort((a, b) => a - b);
  let indexed = 0;
  for (let i = 0; i < values.length; i += 7) indexed += values[i] ?? 0;
  checksum = (checksum + sum + indexed + (sorted[1000] ?? 0) + even.length) % 1_000_000_007;
}
console.log(checksum);
