// One million small objects kept alive in an array, plus one string per object.
// Measures per-object footprint (header + slots + string) of the live heap.
const items: { id: number; name: string }[] = [];
for (let i: number = 0; i < 1000000; i = i + 1) {
  items.push({ id: i, name: `item-${i % 1000}` });
}
let total: number = 0;
for (const item of items) {
  total = total + item.id + item.name.length;
}
console.log(total);
