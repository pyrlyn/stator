// Ten million short-lived objects, each dead before the next (same shape as leak/objects.ts).
// Measures whether the binary's collector keeps RSS flat under a high allocation rate.
let sum: number = 0;
for (let i: number = 0; i < 10000000; i = i + 1) {
  const point: { a: number; b: number } = { a: i, b: i + 1 };
  sum = sum + point.a + point.b;
}
console.log(sum);
