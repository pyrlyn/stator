// Exceptions thrown inside compiled functions and caught by interpreted ones.
function check(n: number): number {
  if (n < 0) throw new RangeError(`negative: ${n}`);
  return n * 2;
}
function deep(n: number): number {
  return n === 0 ? check(-1) : deep(n - 1) + 1;
}
for (const n of [1, -1]) {
  try {
    console.log(check(n));
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
try {
  deep(5);
} catch (e) {
  console.log('deep', (e as Error).message);
} finally {
  console.log('finally');
}
function undefinedCall(): unknown {
  const f: unknown = undefined;
  return (f as () => unknown)();
}
try {
  undefinedCall();
} catch (e) {
  console.log(e instanceof TypeError);
}
function tdz(): number {
  try {
    return late;
  } catch (e) {
    return (e as Error).name === 'ReferenceError' ? -1 : 0;
  }
  const late = 1;
}
console.log(tdz());
