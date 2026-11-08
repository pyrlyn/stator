---
status: in progress
priority: P1
complexity: 4
readiness: 90%
agent: Codex / GPT-6
---

# T71. Measure V8 and optimize a hot JavaScript engine path

The creator requests continued V8 comparisons and Stator JavaScript engine optimization.
Start from origin/main with T68, T67.1's baseline improvements and T69's warmed harness.
This bounded iteration measures the existing corpus and optimizes one demonstrated hot
path, preserving JavaScript semantics. It does not claim T67.1's optimizing tier.

## Execution plan

1. Reuse engine/bench.ts and engine/steady.ts; retain baseline binaries and raw samples.
2. Profile the measured losing kernels. Reuse existing VM semantics and pyrlyn/jit IR;
   change only the responsible engine path after identifying its cost.
3. Add regression and helper-call-count coverage, including exceptional and mixed inputs.
4. Rerun the same corpus against V8 and the baseline; record gains and remaining losses
   in this task and docs/ENGINE.md.

## Check

`pnpm run ci`, `pnpm run interp:test` and `pnpm run engine:test` pass.
`node packages/tests/engine/steady.ts --rounds=3` checks every result against V8 and
confirms JIT compilation. Before/after raw samples on the same host demonstrate a gain
in the targeted kernel beyond observed process variation, with all kernels reported.
`pnpm run engine:bench -- --runs=3` checks the broader cold-start corpus.
