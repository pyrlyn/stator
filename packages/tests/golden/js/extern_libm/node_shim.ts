// Node-side bindings for the extern_libm golden (packages/tests/golden/run.ts): the same
// calls the Stator side makes as direct C calls, spelled in JS. Math mirrors libm bit for
// bit on IEEE doubles (sqrt; fmod IS `%` — both truncated remainders, NaN on divide-by-zero
// included); atof's inputs are chosen where `parseFloat` agrees with it; getenv reads the
// same environment (the runner pins TZ=UTC on both sides). The `@statorError` mirrors
// re-spell the convention check and its message, so a divergence in Stator's check — a
// missing throw, a different message — still fails the diff.
globalThis.sqrt = Math.sqrt;
globalThis.fmod2 = (x, y) => x % y;
globalThis.numOf = (s) => Number.parseFloat(s);
globalThis.getEnv = (name) => process.env[name] ?? 'UNSET';
globalThis.fmodChecked = (x, y) => {
  const r = x % y;
  if (r !== 0) throw new Error("extern call 'fmodChecked' failed: nonzero return");
  return r;
};
globalThis.logChecked = (x) => {
  const r = Math.log(x);
  if (r < 0) throw new Error("extern call 'logChecked' failed: negative return");
  return r;
};
globalThis.getEnvChecked = (name) => {
  const v = process.env[name];
  if (v === undefined) throw new Error("extern call 'getEnvChecked' failed: NULL return");
  return v;
};
globalThis.sqrtErrno = (x) => Math.sqrt(x);
