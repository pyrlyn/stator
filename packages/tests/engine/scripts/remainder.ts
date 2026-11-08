// T71: one compiled site exercises the integer path and every numeric fallback boundary.
function remainder(a: number, b: number): number {
  return a % b;
}
const operands = [
  0,
  -0,
  1,
  -1,
  3,
  -3,
  1.5,
  -1.5,
  0.5,
  -0.5,
  2147483647,
  -2147483648,
  4294967295,
  9007199254740991,
  -9007199254740991,
  9007199254740992,
  -9007199254740992,
  9223372036854775808,
  -9223372036854775808,
  5e-324,
  -5e-324,
  1e300,
  -1e300,
  Infinity,
  -Infinity,
  NaN,
];
for (const a of operands) {
  for (const b of operands) {
    const result = remainder(a, b);
    console.log(result, result === 0 ? 1 / result : 0);
  }
}
console.log(remainder('7' as unknown as number, 3));
console.log(remainder(null as unknown as number, 3));
console.log(remainder(undefined as unknown as number, 3));
let order = '';
const left = {
  valueOf() {
    order += 'L';
    return -12;
  },
};
const right = {
  valueOf() {
    order += 'R';
    return 3;
  },
};
console.log(1 / remainder(left as unknown as number, right as unknown as number), order);
const throwing = {
  valueOf() {
    throw new Error('remainder coercion');
  },
};
try {
  remainder(throwing as unknown as number, right as unknown as number);
} catch (error) {
  console.log((error as Error).message, order);
}
console.log(remainder(-14, 3));
