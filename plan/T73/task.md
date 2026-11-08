---
status: in progress
priority: P1
complexity: 5
readiness: 5%
agent: Codex / GPT-6
---

# T73. Make warmed Stator JIT faster than V8 on the established corpus

Creator-directed: compare Stator JIT with V8 JIT and make Stator faster. Keep T69's
numeric, objects and cycles kernels, excluding startup and checking every answer.
T71 reduced numeric time by 11.06%; the remaining gaps are 8.54x, 52.44x and 32.04x.
Do not close this card merely for another incremental improvement. The creator explicitly
selected memory and object work on 2026-11-08; leave T67.1 with its current owner.

## Execution plan

1. Reuse T69/T71's warmed harness, baseline binaries and raw samples. Check V8 optimized
   compilation separately, without adding instrumentation to throughput measurements.
2. Profile numeric, object and cycle kernels independently. T67.1 is owned elsewhere;
   do not take its optimizing-tier work. Investigate disjoint runtime allocation and
   storage costs first, using the existing collector and object representations.
3. Implement only measured, semantics-preserving improvements, with focused regression
   tests and the existing engine/collector checks. Retain every losing benchmark row.
4. Compare baseline, changed JIT and pinned V8 in interleaved processes. Update docs and
   keep this task open until the complete performance Check is met.

## Check

`pnpm run ci`, `pnpm run interp:test`, and `pnpm run engine:test` pass. The unchanged
three-kernel warmed corpus matches Node byte-for-byte, confirms compiled execution,
and shows lower Stator per-process medians than V8 in every kernel, with nonoverlapping
interquartile ranges over at least five interleaved processes. Record raw measurements,
versions, flags, source hashes, hardware and load. A partial improvement is progress,
not completion or a claim that Stator beats V8 generally.
