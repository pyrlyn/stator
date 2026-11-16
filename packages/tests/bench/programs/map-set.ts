// Hashing: Map with number and string keys, Set membership, deletes that leave tombstones, and
// iteration in insertion order (which Node fixes, so the folded output pins it too).
const counts = new Map<string, number>();
const ids = new Map<number, number>();
const seen = new Set<number>();
let checksum: number = 0;
for (let i = 0; i < 200_000; i += 1) {
  const key = `k${String(i % 5000)}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  ids.set(i % 30_000, i);
  if (seen.has(i % 7919)) checksum += 1;
  else seen.add(i % 7919);
  if (i % 3 === 0) ids.delete((i * 7) % 30_000);
}
for (const key of counts.keys()) checksum += key.length * (counts.get(key) ?? 0);
for (const value of ids.values()) checksum = (checksum + value) % 1_000_000_007;
console.log(checksum, counts.size, ids.size, seen.size);
