# T71. Measured V8 comparison and integer remainder fast path

Delivered on `codex/t71-engine-v8`, in the commit containing this report; base `ec60a284`.
The existing JIT now lowers exact integer `%` directly using pyrlyn/jit's existing IR.
The VM fallback, coercion order, exceptions, signed zero and GC rooting are preserved.
The regression corpus checks 676 numeric operand pairs and coercion/throw cases.
No dependencies or runtime changes; no plan-notes entry was needed.

[Report and reproduction](report.md), [full CI output](checks.txt),
[interleaved samples](interleaved.json). Numeric median time fell **11.06%**:
213.642 → 190.008 us, against V8's 22.252 us. The before/after process ranges do not
overlap. All three kernels and all fifteen cold workloads are reported, including losses.
Stator still loses to warmed V8; T67.1's optimizing-tier goal remains open.

## Check output

All commands ran through `mise exec --` with the pinned Node and Zig.

- `pnpm run ci`: **exit 0**. `837 passed (837)` unit tests; runtime print corpus matches
  Node; `subset: 1041 fixtures — 1010 passed, 31 expected-fail, 0 failed`;
  `golden: 525 fixtures — 525 passed, 0 failed`; selfhost 22 targets match baseline;
  builtin coverage and Node documentation checks pass; all four leak workloads plateau.
  The full ASan/UBSan golden run also reports `525 passed, 0 failed` and
  `asan: golden-asan green — recorded 73e0145d67d9…`.
  Two Intl fixtures are explicitly skipped without the optional Intl runtime.
- `pnpm run interp:test`: **exit 0**. `zig build test --build-file packages/engine/build.zig
  --summary all`: `Build Summary: 9/9 steps succeeded`. The new cost test proves zero
  binary helpers on the integer path and eleven on eleven fallback inputs.
- `pnpm run engine:test`: **exit 0**, `engine: 58 passed, 0 failed`. Repeated against the
  ReleaseFast CLI with `STATOR_ENGINE`: the same 58/0 result.
- `node packages/tests/engine/steady.ts --rounds=3`: **exit 0**, before and after.
  All answers and JIT compilation proofs pass; raw throughput samples are retained.
  The subsequent rotating before/after/V8 comparison confirms the gain.
- `pnpm run engine:bench -- --runs=3`: **exit 0**, all 15 programs match the pinned Node.
- `zig fmt --check packages/engine/src/jit/lower.zig packages/engine/src/interp.zig`
  and `git diff --check`: **exit 0**.

Execution was on arm64 macOS; x86-64 is not claimed as runtime-verified.
