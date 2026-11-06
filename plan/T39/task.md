---
status: todo
priority: P2
complexity: 2
readiness: 0%
agent:
---

# T39. CI job `bootstrap`

Steps:
1. Job on macOS arm64 + Linux x64: build from the T36 snapshot with system cc, run T37 stages,
   run the goldens with the stage2 binary.
2. Skipped (green) until T61 lands, via a flag in `packages/tests/selfhost/targets.json`;
   required on `main` after.

**Check:** the job is green on a PR that only touches docs and red on a PR that breaks the
fixed point.
