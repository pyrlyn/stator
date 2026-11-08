---
status: in progress
priority: P2
complexity: 4
readiness: 70%
agent: Codex / GPT-6
---

# T74. Measure and reduce engine startup and JIT compilation cost

The creator requests lower startup, JIT compilation latency and warmed execution time than
V8. T67.1 retains ownership of the optimizing tier. This task owns the independent startup
and compilation measurements and a measured improvement to compilation cost; T69's warmed
comparison guards execution performance. No universal performance claim follows from a corpus.

## Execution plan

1. Reuse the existing engine benchmark hosts, monotonic runtime clock, pinned Node, timedRun
   and percentile helpers. Measure compilation independently of process startup and execution,
   recording the stage boundaries, successful/rejected templates, versions and raw samples.
2. Profile the baseline compiler on repeatable small and larger functions; reduce the measured
   bottleneck without changing bytecode semantics or creating a second optimizing tier.
3. Compare before/after binaries in alternating runs. Measure cold launch separately and retain
   T69's warmed-kernel comparison as a regression check. Label V8 tier and instrumentation
   boundaries explicitly; do not equate baseline compilation with optimizing compilation.
4. Add regression coverage, update docs/ENGINE.md and record results and limitations here.

## Check

Run `node packages/tests/engine/startup.ts --rounds=9`,
`pnpm run interp:test`, `pnpm run engine:test`, and `pnpm run ci`.
Close only with recorded command output, correct results, and a repeatable measured improvement.
