// ffi-sqrt: FFI extern-call overhead probe over libm `sqrt` (docs/FFI.md).
//
// What it measures. One million scalar `number -> number` extern calls in a tight
// loop, so the compiled-call cost (argument marshal, direct C call, double return)
// dominates the loop body. It complements nbody.ts: nbody measures arithmetic with
// an occasional sqrt, while this file isolates the per-call boundary cost the
// Task 7.1 steps 4-5 lowering must drive to zero.
//
// Scale. nbody.ts runs 200,000 iterations of a sqrt-containing body; this probe runs
// five times that count (1,000,000 bare calls) so the extern-call cost, not the loop,
// shapes the measurement. One sqrt per iteration keeps the cost shape linear in the
// call count: doubling ITERATIONS doubles the extern-call work and nothing else.
// The count is chosen by READING nbody.ts, not by running anything: the target is
// the same 10-100 ms band the existing programs occupy under Node.
//
// Anti-dead-code. The running sum `acc` is printed at the end, so no pass may drop
// the loop as side-effect-free — the same discipline as nbody.ts (`console.log` of
// the folded state), fib.ts, and json-roundtrip.ts. The printed value is the whole
// oracle: `record.ts` byte-compares stdout against `node ffi-sqrt.ts`.
//
// Engine-agnostic WITHOUT shims. The `try` block runs the direct extern call, which
// is the only use position the gate accepts: naming the extern as a value (alias,
// `typeof`, ternary select) is STA1217 not-yet (subset_extern_value_ts.ts), so
// try/catch is the only spelling both engines accept. Under Stator the loop runs
// and the catch never fires; under Node `sqrt` is an undeclared name, the read
// throws a catchable ReferenceError (subset_reference_error_js.js), and ONLY that
// world enters the `catch`, which resets the accumulator and re-runs the identical
// sequence via `Math.sqrt`. Every syntactic element here already exists in shipped
// fixtures: the `/// <reference>` (extern_libm/main.ts), the direct call
// (subset_extern_direct_ts.ts, extern_libm/main.ts), try/catch with `instanceof`
// (extern_libm/main.ts), the `.name` read (subset_reference_error_js.js), the
// rethrow (golden/ts/exceptions.ts), and `Math.sqrt` (nbody.ts, node_shim.ts).
//
// Bit-identity. `Math.sqrt` mirrors libm `sqrt` bit for bit on IEEE doubles
// (extern_libm/node_shim.ts), so the Node fallback prints byte-identical stdout
// and the `record.ts` oracle holds on both paths.
//
// Owed follow-up (NOT in this file): the sibling `ffi-sqrt.d.ts` carrying the
// `/** @statorExtern */ declare function sqrt(x: number): number;` spelling.

// oxlint-disable-next-line typescript/triple-slash-reference -- sibling .d.ts include mechanism (extern_libm/main.ts spelling); import style cannot carry the ambient extern declaration.
/// <reference path="./ffi-sqrt.d.ts" />

// Scale, read off nbody.ts (200,000 sqrt-containing steps): five times that
// count as bare extern calls, so the per-call boundary cost dominates the loop.
// Doubling ITERATIONS doubles the extern-call work and nothing else (linear).
const NBODY_STEPS: number = 200_000;
const SCALE: number = 5;
const ITERATIONS: number = NBODY_STEPS * SCALE;

// Folded state, printed at the end so the loop is never dead code — the same
// discipline as nbody.ts (`console.log` of the accumulated state).
let acc: number = 0;

// Stator path: the direct extern call is the only accepted use position; any
// value-position read of the extern name is STA1217 (subset_extern_value_ts.ts).
try {
  for (let i = 1; i <= ITERATIONS; i += 1) {
    acc += sqrt(i);
  }
} catch (e) {
  // Node path: `sqrt` is undeclared, so ONLY this world throws the catchable
  // ReferenceError (subset_reference_error_js.js) and re-runs below.
  if (e instanceof Error && e.name === 'ReferenceError') {
    // Reset the partial sum: the try body threw partway, so acc holds a prefix
    // that must not leak into the oracle.
    acc = 0;
    for (let i = 1; i <= ITERATIONS; i += 1) {
      acc += Math.sqrt(i);
    }
  } else {
    // Any other throw is a real failure: rethrow, never swallow (exceptions.ts).
    throw e;
  }
}

// Whole oracle in one line: `record.ts` byte-compares this against Node stdout.
console.log(acc);
