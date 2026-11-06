---
status: todo
priority: P2
complexity: 3
readiness: 100%
agent:
---

# T30. Task 6.16 — clone baseline to zero

`.jscpd-baseline.json` is still debt (last measured **129** fingerprints after plan-notes 381;
the Check wants the baseline *empty*). Families still open per that note: `gate.ts`/`generics.ts`
`ts.is*` lists, array switch cases, `jsrt_string_ops`, `hir/verify`, `jsrt_print`, `jsrt_date`.

Steps:
1. One PR per family: extract the helper at the responsible layer (no `dupes` baseline growth
   in any commit; each PR runs `pnpm run dupes:baseline` and the file must shrink).
2. When the last family is gone, **delete** `.jscpd-baseline.json` and the `dupes:baseline`
   script path's baseline argument (or leave the script running with a missing/empty baseline —
   whatever `jscpd` treats as "no baseline"; document the choice in `AGENTS.md` golden rule 10).
3. Keep `pnpm run dupes` in `ci` green with zero clones.

**Check:** `pnpm run dupes` exits 0 with no baseline file (or an empty one); the clone count in
its output is 0; `pnpm run test` still green.
