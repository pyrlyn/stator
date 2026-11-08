function bench(seed: number): number {
  let sum = seed;
  for (let i = 0; i < 10000; i += 1) sum = (sum + i) % 65521;
  return sum;
}
