// Doubles through the JIT's fast paths: NaN canonicalization, -0, past 2^31, mixed operands.
function arith(a: number, b: number): number[] {
  return [a + b, a - b, a * b, a / b, a % b];
}
console.log(arith(7, 2).join(' '));
console.log(arith(0, 0).join(' '));
console.log(arith(-0, 1).join(' '), 1 / -0, Object.is(-0 * 1, -0));
console.log(arith(2147483647, 1).join(' '));
console.log(arith(1e308, 1e308).join(' '));
console.log(0 / 0, Infinity - Infinity, Math.sqrt(-1));
console.log(0.1 + 0.2, 1 / 3, 123456789 * 987654321);
let nan: number = 0 / 0;
console.log(nan === nan, nan !== nan, nan < 1, nan >= 1);
function cmp(a: number, b: number): boolean[] {
  return [a < b, a > b, a <= b, a >= b, a === b, a !== b];
}
console.log(cmp(1, 2).join(), cmp(2, 2).join(), cmp(-0, 0).join());
function inc(n: number): number {
  let x = n;
  x++;
  x--;
  x++;
  return -x;
}
console.log(inc(41), inc(-1), inc(2147483647));
const mixed: unknown[] = [1, '2', true, null, undefined];
for (const m of mixed) console.log(String(m), (m as number) + 1, (m as number) * 2);
