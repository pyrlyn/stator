// Map and Set built from one iterable argument in ts mode (plan.md §11c T11.4 step 6,
// docs/VALUE.md §4.25): typed pairs, a Map copied, values, keys, and typed reads after.
const m = new Map<string, number>([['a', 1], ['b', 2]]);
let total = 0;
m.forEach((v, k) => {
  total += v;
  console.log(k.toUpperCase(), v * 2);
});
console.log(total, m.get('b'));
const pairs: [number, string][] = [[1, 'one'], [2, 'two']];
const byNum = new Map(pairs);
console.log(byNum.get(2)?.length, byNum);
const words = ['x', 'y', 'x'];
const uniq = new Set(words);
console.log(uniq.size, [...uniq].join('-'));
const nums = new Set<number>([1.5, 2.5, 1.5]);
let sum = 0;
for (const n of nums) sum += n;
console.log(sum);
const copy = new Map(m);
copy.set('c', 3);
console.log(copy.size, m.size);
const keys = new Set(m.keys());
console.log(keys.has('a'));
