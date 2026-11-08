let cycleRoot = null;
function bench(seed: number): number {
  let sum = seed;
  for (let i = 0; i < 1000; i += 1) {
    const a = { value: i, next: null };
    const b = { value: seed, next: a };
    a.next = b;
    cycleRoot = a;
    sum += a.next.value + b.next.value;
  }
  return sum;
}
