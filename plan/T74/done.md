# T74. Measured startup and compilation improvement

Delivered on `codex/t74-jit-compile-startup`, in the commit containing this report;
base `149ebde3458e5acb0cd2ac9a00e7f3240385379c`.

The Zig baseline JIT orders acyclic reachable IR in reverse postorder before the existing
pyrlyn backend. Cyclic graphs retain their original layout: an unrestricted trial regressed
warmed object execution and was rejected. Structural tests cover diamonds, backedges and block
arguments. Compilation-stage timing uses the runtime's existing monotonic clock only when the
existing JIT trace switch is enabled. The new benchmark reuses the build, timing and percentile
helpers, checks answers against pinned Node, and separates process startup from compilation.

[Report and reproduction](report.md), [startup samples](startup.json),
[warmed samples](warmed.json), [full CI output](ci.log).
Nine rotating rounds on the larger synthetic function set measure compilation **20.8% faster**
(40.153 → 31.786 ms) and cold process completion **16.9% faster** (48.204 → 40.052 ms).
The small-program launch and warmed before/after ranges overlap; no improvement is claimed
there. Stator still loses to Sparkplug compilation at both sizes, TurboFan compilation at the
larger size, and V8 execution on all three warmed kernels. The overall faster-than-V8 goal
remains open; T67.1 retains the optimizing tier.

Documentation is updated in `docs/ENGINE.md` and `packages/engine/README.md`. The T74 entry in
`plan-notes.md` records the scope split, measured mechanism and rejected trial. No dependency,
parser, value model, collector or register allocator was added.

## Check output

Commands use `mise exec --` for Node 26.7.0 and Zig 0.17.1.

- `node packages/tests/engine/startup.ts --rounds=9`, with the before/after binary overrides:
  **exit 0**. All cold answers match Node, and all expected functions have successful compilation
  records for Stator, Sparkplug and TurboFan. [Command output](startup.log).
- `pnpm run interp:test`: **exit 0**. The same build with `--summary all` reports
  `Build Summary: 9/9 steps succeeded; 49/49 tests passed`. [Output](engine-unit.log).
- `pnpm run engine:test`, using the final ReleaseFast CLI: **exit 0**,
  `engine: 58 passed, 0 failed`. [Output](engine-corpus.log).
- `pnpm run ci`: **exit 0**, on the final acyclic-layout implementation. `67 passed` test
  files, `843 passed` unit tests; `0 clones`; runtime print corpus matches Node;
  `subset: 1041 fixtures — 1010 passed, 31 expected-fail, 0 failed`;
  `golden: 525 fixtures — 525 passed, 0 failed`; selfhost matches its baseline;
  builtin and Node-documentation checks pass; all four leak workloads plateau.
  The full ASan/UBSan golden run reports `525 passed, 0 failed` and
  `asan: golden-asan green — recorded ee2a01466dcd…`. Two optional Intl fixtures are explicitly
  skipped, as are the platform-inapplicable sanitizer diagnostic cases.
- The rotating warmed regression check: **exit 0**, three rounds per engine/kernel with
  the unchanged T69 drivers. Every result and both Stator compilation proofs pass.
  [Per-process output](warmed.log); ranges and limitations are in the report.
- `zig fmt --check` on the three changed Zig files and `git diff --check`: **exit 0**.

Execution was validated on arm64 macOS. No x86-64 execution or universal performance claim
is made.
