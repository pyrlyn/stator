---
status: todo
priority: P3
complexity: 1
readiness: 100%
agent:
---

# T31. Task 6.3 noise floor on the weekly runner's machine

The 20% perf gate stands on a 7.4%–14.4% spread measured on **other** hosts (plan-notes 246/374).
The Check wants repeats on the machine that runs the weekly job.

Steps:
1. On that host: one commit, ≥5 `pnpm run bench` repeats; record geomeans + spread in
   `plan-notes.md` (host, CPU, commit sha).
2. Set `thresholdPercent` in the bench gate from that spread (keep ≥2× headroom; do not lower
   it onto the noise floor). If the weekly host is unavailable indefinitely, record that fact
   and leave the gate at 20% — a named "unmeasured" is better than a guessed number.

**Check:** plan-notes cites the weekly-host numbers (or the unavailability record) and the gate
value in `packages/tests/bench/` matches that decision.
