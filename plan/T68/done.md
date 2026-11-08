# T68. Make the engine's interpreter faster — done

## What was done

Fast paths that restate the runtime's own answer for the common case; everything else still takes
the existing path.

- **Exception check.** The runtime exports the calling thread's pending flag
  (`jsrt_pending_flag`, `packages/runtime/src/jsrt_throw.c`). The VM reads its address once per
  thread (`Machine.pending` in `packages/engine/src/vm.zig`) and tests it in place after each
  instruction, instead of calling `jsrt_pending()` and paying `_tlv_get_addr` every time.
  Arithmetic on two numbers cannot throw, so it skips the check.
- **Numbers.** `+ - * / %`, the comparisons and equalities on two numbers, and `++ -- - +` on a
  number are computed inline; `%` on two exact integers uses integer remainder with the sign of
  the dividend. Jumps test `true`/`false` before calling `jsrt_truthy`.
- **Globals.** One inline cache per template key (`Template.global_ics`, filled in `compile.zig`)
  maps the global object's shape to the slot; `loadGlobal` and `storeGlobal` hit it before the
  `jsrt_has_prop` + `jsrt_get_prop` walk. Accessors, a frozen global and misses take the walk.
  The JIT's helpers pass the template and key index too.
- **Properties.** `getProp` and `setProp` on a dynamic object whose shape matches the site's IC
  read or write the slot directly; accessors, frozen objects and `constructor` take the runtime.
- **Arrays.** `getElem` and `setElem` with an in-range integral index on an array touch the
  element directly (holes still read as `undefined`).

## Check

- `mise exec -- pnpm run interp:test`: passes.
- `mise exec -- pnpm run engine:test`: `engine: 54 passed, 0 failed` (both tiers).
- `mise exec -- pnpm run test262:interp-exec` (corpus 771005236e88a909635104e03ba12559688c0172):
  no regression; `3 directories pass more than the baseline` (not recorded here).
- `zig fmt --check packages/engine/src packages/engine/test262 packages/engine/build.zig`: clean.
- `pnpm run dupes`: exit 0.

## Benchmark

`stator-engine run` (interpreter tier, `-Doptimize=ReleaseFast`) against QuickJS 2026-06-04 and
the pinned Node, wall time in ms, best of 5 runs under hyperfine, Apple M3 Max. Every answer
matches QuickJS and Node. `g-*` scripts keep their state in globals, the others in function
locals.

| Script | Before | After | QuickJS | Node | After / QuickJS |
| --- | ---: | ---: | ---: | ---: | ---: |
| array | 239 | 138 | 35 | 35 | 3.9 |
| closure | 157 | 92 | 24 | 30 | 3.8 |
| fib | 78 | 46 | 16 | 31 | 2.9 |
| loop | 333 | 141 | 47 | 40 | 3.0 |
| objects | 156 | 110 | 48 | 32 | 2.3 |
| sieve | 427 | 264 | 69 | 42 | 3.8 |
| string | 49 | 35 | 14 | 33 | 2.5 |
| g-array | 675 | 216 | 43 | 34 | 5.0 |
| g-closure | 265 | 112 | 26 | 29 | 4.3 |
| g-fib | 91 | 50 | 16 | 31 | 3.1 |
| g-loop | 704 | 228 | 51 | 38 | 4.5 |
| g-objects | 267 | 130 | 50 | 33 | 2.6 |
| g-sieve | 433 | 266 | 68 | 44 | 3.9 |
| g-string | 81 | 42 | 16 | 35 | 2.6 |

## Left

`a.push(x)` and other array methods still go through `jsrt_array_method`, which scans a `strcmp`
table and allocates a bound method per lookup; that and the call path are the largest remaining
costs in `sieve`, `array` and `fib`.
