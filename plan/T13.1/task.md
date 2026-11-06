---
status: todo
priority: P3
complexity: 4
readiness: 0%
agent:
---

# T13.1. `packages/webapi`: the DOM

Depends on T13.0 and T13.5. New workspace package, strict TS (§0.9, §0.10), compiled by Stator.
The DOM subset from T13.0 §3, against a recording renderer (T13.3's test double) so no pixels are
needed. Every member it proves is claimed in `webapi_coverage.json` and `docs/WEBAPI.md` is
regenerated in the same change (T13.5) — the rule for every later Phase 13 card too.

**Check:** the T13.0 DOM oracle slice passes in both modes, byte-for-byte against the oracle;
every unsupported member surfaces in `explain` as `not-yet`, not as `STA0012`.
