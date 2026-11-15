// Typed-array storage on a numeric kernel: a sieve over a Uint8Array, then byte views made with
// subarray and copied with set, so element loads and the view machinery are both on the path.
const LIMIT: number = 2_000_000;
const composite = new Uint8Array(LIMIT + 1);
let primes: number = 0;
for (let i = 2; i <= LIMIT; i += 1) {
  if (composite[i] === 1) continue;
  primes += 1;
  for (let j = i * i; j <= LIMIT; j += i) composite[j] = 1;
}

const block = new Uint8Array(4096);
let checksum: number = 0;
for (let round = 0; round < 200; round += 1) {
  for (let i = 0; i < block.length; i += 1) block[i] = (i * 31 + round) & 255;
  const window = block.subarray(round, round + 1024);
  const copy = new Uint8Array(1024);
  copy.set(window);
  for (let i = 0; i < copy.length; i += 3) checksum += copy[i] ?? 0;
}
console.log(primes, checksum);
