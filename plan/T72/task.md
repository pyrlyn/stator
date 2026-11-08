---
status: in progress
priority: P1
complexity: 2
readiness: 80%
agent: Codex / GPT-6
---

# T72. Speed up the full local test run

Creator-directed: reduce full local test time without dropping fixtures, weakening comparisons,
or changing compiler semantics. Reuse the existing subset/golden shard runner and merge checks.

## Steps

1. Measure the unmodified full subset runner and compare existing process sharding.
2. Enable bounded automatic sharding for full runs only if measurements justify it; preserve
   explicit shard selectors, serial debugging, impact recording and small filtered runs.
3. Add regression coverage for worker selection and result/error preservation. Document the
   defaults and overrides in `docs/TOOLCHAIN.md` and the standing contract in `plan.md`.
4. Compare identical complete fixture sets and run the repository gate.

## Check

- Before/after full subset and golden reports match, including exit status; record wall times.
- `pnpm run test` and `pnpm run ci` pass.
- No fixture, expected result, comparison or existing check is removed.
