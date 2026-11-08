---
status: in progress
priority: P1
complexity: 5
readiness: 70%
agent: Codex / GPT-6
---

# T70. Make the interpreter faster than QuickJS and PrimJS across the benchmark set

The creator requests interpreter performance above QuickJS and PrimJS on the whole set: loops,
recursion, arrays, objects, closures and strings. Continue from the first T70 implementation in PR #293 on origin/main. Use
interp mode only, preserve JavaScript results, and report every workload including losses.
PrimJS is now a required performance target, not just an additional comparator.

## Execution plan

1. Reuse the engine CLI, runtime, timing helper and pinned Node oracle. Commit the exact
   JavaScript workloads and a repeatable QuickJS comparison with raw samples and versions.
2. Profile the merged T70 baseline, including startup, call frames, numeric loops and strings. Optimize the measured VM overhead using the existing bytecode
   and runtime operations; do not duplicate the JIT or change another session's work.
3. Add regression coverage for changed execution paths, including throwing operations and
   mixed values. Check both interpreter and JIT correctness and the Test262 ratchet.
4. Strengthen the existing comparison gate to require wins against both competitors. Record
   before/after measurements on the same machine and update docs/ENGINE.md. Keep the seven
   committed workloads unchanged; use separate scaled copies only for profiling.

## Check

`pnpm run ci`, `pnpm run interp:test`, `pnpm run engine:test`, and
`pnpm run test262:interp-exec` pass. The repeatable comparison checks every output against
the pinned Node and QuickJS and records at least five interleaved samples per program.
Every workload's interpreter median must beat both QuickJS and PrimJS beyond measured run variation.
`pnpm run engine:bench:quickjs --require-faster` enforces non-overlapping interquartile ranges;
The gate requires `PRIMJS` and checks both release engines with identical inputs and outputs.
Until that holds, leave this task open and report the remaining gap explicitly.
