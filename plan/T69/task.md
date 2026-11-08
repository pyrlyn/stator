---
status: in progress
priority: P1
complexity: 4
readiness: 90%
agent: Codex / GPT-6
---

# T69. Measure the JIT against warmed V8 and expose full GC pauses

The creator requests faster dynamic JavaScript and GC than warmed V8. T67 supplies the
baseline JIT; T67.1 is owned by another session. Its existing benchmark measures process
startup as well as execution. This task supplies the missing measurement, without duplicating
the optimizing tier or claiming that a benchmark alone makes Stator faster.

## Execution plan

1. Reuse `engineBinary`, `timedRun`, the pinned Node, the engine and runtime ABI. Add a
   benchmark-only host with a monotonic clock; do not add globals to the production engine.
2. Run identical JavaScript kernels with warmup and repeated measured batches in each process.
   Validate every result, retain raw samples, alternate engine order, record source hashes,
   commit, versions, flags, hardware and process peak RSS. Report startup separately.
3. Add opt-in GC tracing around the whole Stator collection, including root scanning and
   deferred-count reconciliation. Observe V8 GC events in a separate process; keep all
   instrumentation disabled in throughput runs. Prove the kernels compiled in the trace run.
4. Run correctness checks and a same-host baseline, document the remaining gap and the method
   in `docs/ENGINE.md`; preserve existing cold benchmarks.

## Check

`pnpm run ci`, `pnpm run interp:test`, `pnpm run engine:test`, and
`node packages/tests/engine/steady.ts --rounds=3` pass. The warmed benchmark checks the same
results for every invocation in both engines, reports all individual workloads (including
losses), and records raw measurements. GC tracing must report nonnegative full-collection
durations on an allocating script without changing its stdout.

The overall goal of beating V8 remains open unless measurements demonstrate it; it is not this
measurement task's completion criterion.
