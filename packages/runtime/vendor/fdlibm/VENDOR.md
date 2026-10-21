# fdlibm — the transcendentals, from V8

`Math.sin` and its nineteen siblings, vendored rather than delegated to the host libm.

| | |
|---|---|
| Upstream | <https://github.com/v8/v8> — `src/base/ieee754.cc` |
| Version | V8 `14.6.202` — the V8 inside the pinned Node `26.7.0` (`process.versions.v8`) |
| License | fdlibm (SunSoft, 1993) + V8's BSD-3-Clause — see `LICENSE` |
| Vendored | 2026-09-01 |
| Converted by | `port.ts` (C++ → C11, mechanical) |

## Why this is here

Golden tests diff against the pinned Node **byte-for-byte**, and the host libm does not agree with
V8 on a single transcendental. Measured on macOS arm64 over 380,000 random inputs (plan-notes 117):

| | host libm vs Node | this file vs Node |
|---|---|---|
| worst function | `tan`, 41.38% of inputs differ | 0 |
| best differing function | `log2`, 0.09% differ | 0 |
| total | **differs on all 19** | **0 / 400,000** |

The differences are 1–2 ulp — invisible to a tolerance comparison, fatal to a byte-for-byte one, and
they change with the libm that happened to build the runtime. That is what made `Math.acos` and its
siblings undeliverable while the runtime called libm, and it is why `runtime/src/jsrt_math.c` used
to carry a comment saying so. This file removes the problem at its root: Stator now computes the
transcendentals with the same code Node does, so agreement is structural rather than lucky.

## What is here

| File | Why |
|---|---|
| `fdlibm.c` | The engine — 20 entry points, generated from upstream by `port.ts`. |
| `fdlibm.h` | Their declarations, `fdlibm_`-prefixed. |
| `port.ts` | The C++ → C11 conversion, so a version bump is re-download + re-run. |
| `LICENSE` | Upstream's, unmodified. |

**Not here:** `hypot` and `random`. Neither lives in `ieee754.cc` upstream — V8 implements
`Math.hypot` in its own builtins and `Math.random` in an xorshift PRNG — so both are Stator's own
code in `runtime/src/jsrt_math.c`, not vendored.

## Why the entry points are renamed

Every entry point is `fdlibm_`-prefixed (`fdlibm_acos`, not `acos`). Without it, defining `double
acos(double)` in a translation unit that also includes `<math.h>` is a collision, and which one a
given call site binds to is a linker detail — precisely the "whichever libm built it" problem this
file exists to remove. The prefix makes the choice explicit at every call site.

## Rules

**Never hand-edit `fdlibm.c`** (AGENTS.md, Don'ts). It is generated. A change that turns out to be
necessary is a `plan-notes.md` entry first, then an edit to `port.ts` — which keeps the next
version bump a re-run rather than a merge: `node packages/runtime/vendor/update.ts fdlibm [ref]` downloads
upstream's `ieee754.cc` into a temp dir and runs `port.ts` over it. `LICENSE` is assembled by hand
(SunSoft's notice + V8's, neither of which is a file upstream), so that script never touches it —
re-read it when a bump crosses a license change.

Like `quickjs-ng/`, this directory compiles with `-Wall` alone rather than the runtime's full
`-Wall -Wextra -Werror` (plan-notes 101): holding code we may not edit to our own warning policy
would force exactly the edits that rule forbids.
