# T11.3a. Closing report

**Phase 11 — T11.3a `Uint8Array` across the extern boundary ✅ (2026-10-02)**

**Landed 2026-10-02** (plan-notes 311, changelog v4.39). A `Uint8Array` is a parameter row of
the FFI table (docs/FFI.md §2). The new ABI kind is `bytes`: one TS parameter, two C arguments
(`uint8_t *`, `size_t`), pointing at the view's own storage for the call, with no copy. The
classifier maps it in `frontend/extern.ts`, and a return is STA1119 because a returned buffer has
no owner and no length. Exports keep the `jsrt_value` form. The lowering checks a dynamic
argument, and the emitter guards every other one with `jsrt_check_uint8array` (STA2001), because a
js-mode caller can reach an annotated `.ts` parameter with anything. The runtime gains the
`jsrt_uint8array_bytes`/`_count` accessors and the check. `std/io.writeBytes`/`read` take the row,
and the byte channel (`internal/bytes.ts`, `jsrt_std_bytes_*`) is deleted. A new fixture's Node
twin may be `node_shim.ts`.

**GC rule, as checked against T11.1's design.** The view stays in its rooted argument slot for the
call, and its `buffer` edge keeps the data block alive. Boehm is non-moving and the no-GC build is
plain malloc. A buffer never resizes or detaches. The C call runs no Stator code. So the pointer
is stable until the callee returns. No design change was needed.

**Check evidence:**

- **Decision tests, both modes:** `pnpm run test:subset` → 813 fixtures, 778 passed,
  35 expected-fail, 0 failed. New: `subset_extern_bytes_ts`/`_js` (static),
  `subset_extern_bytes_dynamic_js` (dynamic: the lowering's check), and
  `subset_extern_bytesret_ts`/`_js` (error `STA1119`).
- **Goldens, byte for byte vs Node:** `pnpm run test:golden` → 413 passed.
  - `golden/ts/extern_bytes` passes views into fixture C (`ffi.c`) and gets bytes back. It
    covers a fill through a `subarray`, a reverse in place, a window over `buf.buffer`, empty
    views and a 1 MiB fill. Its Node twin is `node_shim.ts`.
  - `golden/ts/std_io` writes a whole view and an offset `subarray` through `std/io.writeBytes`.
  - `unit/std.test.ts` reads a MiB from stdin through `std/io.read` and writes it back
    unchanged.
- **ASan:** `node packages/tests/golden/asan-gate.ts` → the print corpus matches Node under
  ASan/UBSan, 413 passed, `golden-asan green`.
- **One call, not 1M:** `extern_bytes` prints `calls for 1 MiB: 1` on both sides.
  `unit/std.test.ts` asserts a single `jsrt_std_io_write_bytes(`/`jsrt_std_io_read(` call site,
  each passing pointer + length.
- **Timing (hyperfine, M3 Max):** 10 MiB written goes from 87.1 to 3.9 ms, and 10 MiB read from
  247.5 to 5.3 ms, against a 3.6 ms startup floor. The numbers are in plan-notes 311.
- **The guard:** `unit/extern-bytes.test.ts` (5 tests) covers four things.
  - The classifier: a parameter is `bytes`, a return is `STA1119`, and the export position falls
    back to `jsrt_value`.
  - The paired prototype and arguments.
  - One guard per call, and none doubled on a dynamic argument.
  - A string through `std/io.writeBytes` from js mode ends with SIGABRT and `STA2001`, not
    SIGSEGV.
- **Rest of `pnpm run ci` (exit 0):** typecheck and lint are clean. `cpd`: 207 clones, none new.
  vitest: 51 files, 683 tests. `builtins` 242/304; `node-coverage` current; leak plateau.
  selfhost: 8 targets match the baseline, no `--update` needed (`std/io` stays static).

The card as it stood in plan.md:

The stub `plan.md` kept when the task closed:

~~**T11.3a. `Uint8Array` across the extern boundary.**~~ ✅ **landed 2026-10-02** — evidence above (plan-notes 311).
