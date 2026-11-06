---
status: in progress
priority: P1
complexity: 4
readiness: 100%
agent:
---

# T10.1. `std` low-level API (sans threads)

Steps:

1. Write `docs/STD.md` (module path, error model, v0 table above). Add stub `SUBSET.md` rows /
   diagnostics that name Phase 10.
2. ~~Wire `std/env` and `std/path` end-to-end (types → runtime → golden).~~ Landed (plan-notes
   284), then moved into `packages/std` by T11.2.
3. ~~Add `std/process` (`exit`/`pid`).~~ Landed in `packages/std` by T11.2 (plan-notes 294).
4. ~~Add sync `std/fs` + `std/time` (`nowMs`; sync `sleepMs` only).~~ Landed in `packages/std`
   by T11.2 (plan-notes 294).
5. Promise-flavored `std/fs` APIs: either `not-yet` until T10.2, or implemented as sync under a
   documented lie — **prefer not-yet** so async programs do not block main by accident.

Steps 2–4 live in `packages/std` since T11.2 (plan-notes 294); step 5 is what remains — today
`std/fs` simply has no Promise members, and the card closes when that refusal is a `not-yet`
naming Phase 10.

**Check:** goldens for env/path/process/fs sync; subset rows match; no Node polyfill dependency.
