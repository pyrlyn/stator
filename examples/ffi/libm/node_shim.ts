// Node-side bindings for the libm step-1 example: the same calls the Stator side
// makes as direct C calls, spelled in JS. Math mirrors libm bit for bit on IEEE
// doubles (sqrt; fmod IS `%` — both truncated remainders); pow/fabs map to their
// Math names; floor is floor. NaN propagates on both sides, so the domain-error
// line agrees by construction.
type Bindings = Record<string, unknown>;
const bindings = globalThis as unknown as Bindings;
bindings['libmSqrt'] = Math.sqrt;
bindings['libmFmod'] = (x: number, y: number): number => x % y;
bindings['libmPow'] = Math.pow;
bindings['libmFabs'] = Math.abs;
bindings['libmFloor'] = Math.floor;
