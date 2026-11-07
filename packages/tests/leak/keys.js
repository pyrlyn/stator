// Computed-key reads of keys the receiver never stores (plan T16).
//
// Each miss used to intern a UTF-8 key for the life of the process: malloc(3*len+1)
// plus a 24-byte intern node, neither of which the collector can free. Across 2_000_000
// distinct decimal keys the retained floor is about 80 MB (the 1_000_000 seven-digit
// keys alone are 46 bytes each), above the shared 64 MB cap. A run that frees the
// conversion retains only the empty object, so RSS plateaus in the same few MB as
// objects.ts. The checksum is the miss count: a runtime that skipped the reads
// could not print it.
let n = 0;
const o = {};
for (let i = 0; i < 2000000; i = i + 1) {
  const key = String(i);
  if (o[key] === undefined) {
    n = n + 1;
  }
}
console.log(n);
