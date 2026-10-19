// Node-side bindings for the libm step-1 example: the same calls the Stator side
// makes as direct C calls, spelled in JS. Math mirrors libm bit for bit on IEEE
// doubles (sqrt; fmod IS `%` — both truncated remainders); pow/fabs map to their
// Math names; floor is floor. NaN propagates on both sides, so the domain-error
// line agrees by construction.
globalThis.libmSqrt = Math.sqrt;
globalThis.libmFmod = (x, y) => x % y;
globalThis.libmPow = Math.pow;
globalThis.libmFabs = Math.abs;
globalThis.libmFloor = Math.floor;
