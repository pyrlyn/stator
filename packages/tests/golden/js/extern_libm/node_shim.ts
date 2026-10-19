// Node-side bindings for the extern_libm golden (packages/tests/golden/run.ts): the same
// calls the Stator side makes as direct C calls, spelled in JS. Math mirrors libm bit for
// bit on IEEE doubles (sqrt; fmod IS `%` — both truncated remainders, NaN on divide-by-zero
// included); atof's inputs are chosen where `parseFloat` agrees with it; getenv reads the
// same environment (the runner pins TZ=UTC on both sides). The `@statorError` mirrors
// re-spell the convention check and its message, so a divergence in Stator's check — a
// missing throw, a different message — still fails the diff.
type Bindings = Record<string, unknown>;
const bindings = globalThis as unknown as Bindings;
bindings['sqrt'] = Math.sqrt;
bindings['fmod2'] = (x: number, y: number): number => x % y;
bindings['numOf'] = (s: string): number => Number.parseFloat(s);
bindings['getEnv'] = (name: string): string => process.env[name] ?? 'UNSET';
bindings['fmodChecked'] = (x: number, y: number): number => {
  const r = x % y;
  if (r !== 0) throw new Error("extern call 'fmodChecked' failed: nonzero return");
  return r;
};
bindings['logChecked'] = (x: number): number => {
  const r = Math.log(x);
  if (r < 0) throw new Error("extern call 'logChecked' failed: negative return");
  return r;
};
bindings['getEnvChecked'] = (name: string): string => {
  const v = process.env[name];
  if (v === undefined) throw new Error("extern call 'getEnvChecked' failed: NULL return");
  return v;
};
bindings['sqrtErrno'] = (x: number): number => Math.sqrt(x);
