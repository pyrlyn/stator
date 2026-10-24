# ryu — shortest round-trip double→string

`Number::toString`'s digit source, vendored rather than reimplemented: plan.md golden rule 5
extends to "don't write a float printer — vendor Ryū", and docs/VALUE.md §3.1 already names this
directory. It replaces `shortest_digits()`'s round-trip search over `%.*e` (up to 18
`snprintf`+`strtod` pairs per number) with one call to `d2s_buffered`.

| | |
|---|---|
| Upstream | <https://github.com/ulfjack/ryu> |
| Version | `v2.0` |
| Commit | `72e18e8d14d4392a4a3261f37cde248e4fbedbec` |
| License | Apache-2.0 OR Boost-1.0 — see `LICENSE-Apache2` and `LICENSE-Boost` |
| Vendored | 2026-10-24 |

## What is here

| File | Why |
|---|---|
| `ryu.h` | Public API: `d2s_buffered_n`, `d2s_buffered`, `d2s`. |
| `d2s.c` | The double→shortest algorithm. |
| `d2s.h` | Internal decomposition (pow5 tables and helpers). |
| `d2s_full_table.h` | The full 5^k split table (`RYU_OPTIMIZE_SIZE` is not set). |
| `d2s_intrinsics.h` | 64×64→128 and shift helpers used when `__uint128_t` is absent. |
| `common.h` `digit_table.h` | Exponent/decimal helpers and the two-digit lookup. |
| `LICENSE-Apache2` `LICENSE-Boost` | Upstream's, unmodified. |

Deliberately NOT vendored: `f2s.c` (float), `s2d.c`/`s2f.c` (parse), `d2fixed.c` (fixed-point),
`generic_128.c`, the Bazel/BUILD glue, benchmarks and tests. Stator needs exactly the
double→shortest half, and `jsrt_print.c` keeps ECMA-262's surrounding format (docs/VALUE.md §3.2).

The drop is **flat** (upstream's `ryu/` directory is stripped) because the sources
`#include "ryu/<file>"` and `VENDOR_INC` carries `-Ivendor`, which resolves that path to
`vendor/ryu/<file>`. Re-vendor: `node packages/runtime/vendor/update.ts ryu [ref]`
(`pnpm run vendor:update`).

## The one seam

`shortest_digits()` in `runtime/src/jsrt_print.c` calls `d2s_buffered` on a finite, strictly
positive double and parses the `D[.DDD]E±X` shape into ECMA-262 step 5's `(s, k, n)`. Every
caller below that seam is unchanged. Sign, NaN, Infinity and ±0 stay in `format_double`, which
never reaches Ryū with them.

## Rules

**Never hand-edit these files** (AGENTS.md, Don'ts). A patch that turns out to be necessary is a
`plan-notes.md` entry first, applied as a recorded diff against the pinned commit — so that the
next version bump is a re-vendor plus a re-apply, and never a silent divergence.

They are also an exception to the runtime's `-Wall -Wextra -Werror`: the justfile compiles
`vendor/` with `-Wall` alone, because holding code we may not edit to our own warning policy
would force exactly the edits that rule forbids (plan-notes 101). The bridge in `runtime/src/`
is ours, and is held to the full flags like everything else there.
