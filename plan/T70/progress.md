# T70 progress — task remains open

The interpreter has been optimized and a reproducible comparison with QuickJS and PrimJS
has been added. This is a progress record, not a closing report: the requested win on every
workload has not been established.

## Integration with main

Before publication this patch was rebased onto `ec60a284` (T67.1 and T69). The JIT's direct-call
stack context, inline property/global caches and plain-call return path are preserved. Its
dead-store analysis now recognizes the local reads in the new combined instructions, with
regression coverage for both operands of a local/local operation and a local/immediate operation.
The recorded measurements below describe the pre-integration executable identified by their
hashes; they are not substituted with numbers from the newer main branch. Integration checks
are repeated on the PR head before merge.

## Implementation

- Labeled opcode dispatch, specialized numeric operations and exception checks only where an
  instruction can throw. Internal calls reuse the current machine and its runtime TLS addresses.
- Immutable call values read from the activation header when they cannot be captured; derived
  constructors retain their mutable `this`. Simple parameters initialize their local directly.
- Combined instructions for discarded local updates, local arithmetic/comparisons and named
  property reads. Mixed values, coercion, TDZ and throwing getters retain the runtime semantics.
- Activation-rooted literal and direct array-method caches. Receiver changes and own property
  overrides bypass the method cache. Suspension clears caches; no template holds GC values.
- Baseline JIT decoding/lowering for the new bytecode, using the existing operation helpers.
- Tests for receivers, construction, coercion, TDZ, overrides, argument evaluation, suspension,
  parameter initialization and invalid `super()` inside eval.

The initially discovered eval regression was fixed before the final ratchet run. Excessive
inlining of the call helpers regressed recursive performance in an experiment and was removed.
No runtime dependency, compiler flag, diagnostic, conformance baseline or clone baseline changed.

## Validation

Two full `mise exec -- pnpm run ci` runs exited 0 before the final dispatch consolidation.
The affected engine checks were repeated afterward, as recorded below. The later CI run reported:

```text
Test Files 64 passed (64)
Tests 833 passed (833)
subset: 1041 fixtures — 1010 passed, 31 expected-fail, 0 failed
golden: 525 fixtures — 525 passed, 0 failed
runtime: print corpus matches Node (ASan/UBSan)
ffi static-lib: ok (asan, two libraries, two collectors collecting on every allocation)
golden: 525 fixtures — 525 passed, 0 failed
asan: golden-asan green
```

The two `intl_*` fixtures were explicitly skipped by the ordinary/ASan golden runners, as
usual for a build without ICU. The leak gate reported all four workloads plateauing below
the 65,536 KB cap. Type checking, lint and duplication checks also ran separately.

`mise exec -- pnpm run interp:test` exited 0 after the final dispatch consolidation.
The ReleaseSafe engine tests also exited 0 before that consolidation. The CLI corpus reported
`engine: 54 passed, 0 failed`; the final executable is checked again with the benchmark outputs.

`STATOR_TEST262=<pinned corpus> mise exec -- pnpm run test262:interp-exec` reported:

```text
test262-exec: 14654 / 23726 pass (61.76%)
not run: 817 module tests; unsupported constructs in 1280 tests; 0 timeouts; 24 crashes
test262-exec: 3 directories pass more than the baseline; record them with --update
```

This is a passing ratchet, not complete Test262 conformance. The baseline was not rewritten.
The execution ratchet was repeated after the final consolidation: exit 0, with the same counts. The final CLI corpus again reported `engine: 54 passed, 0 failed`; duplication checks reported `0 clones`.

## Comparator provenance

The original Stator executable was built from T68 at `444ca59f` with Zig 0.17.1 ReleaseFast,
using the same runtime archive as the changed interpreter. QuickJS is the installed
2026-06-04 release, run with `--script`. The pinned Node v26.7.0 supplies expected stdout.

PrimJS is built from upstream commit `941a365bfec2afc709488a4ec8dcb3eba962e1a3`, version
`2.11.1-rc.1`. Its pinned buildroot and gyp dependencies and upstream GN binary are kept
under the ignored `.cache/primjs` checkout. No PrimJS source was patched. The release build is:

```sh
buildtools/gn/gn gen out/Default_snapshot --args='target_cpu="arm64" is_debug=false mac_deployment_target="11.0"'
ninja -C out/Default_snapshot -j4 qjs_exe
```

The deployment target selects a macOS version supported by the installed Xcode SDK; upstream's
10.13 default fails the SDK's libc++ check on arm64. This build uses upstream's snapshot
interpreter, virtual stack and tracing GC. Its runtime reports:

```text
runtime: gc=1 slots=0 allocation_tracking=0 registry_bytes=0 registry_count=0
```

PrimJS is an additional comparator. The required performance gate remains QuickJS.
No `plan-notes.md` decision was needed: the pipeline, value model and runtime ABI are unchanged.

## Final measurement (2026-11-08)

Apple M3 Max, macOS 27.0.1, Node v26.7.0, Zig 0.17.1. Wall milliseconds including startup,
medians of 15 rotating repetitions after one untimed run, identical stdout in every engine.
This run began after this task's builds, CI and Test262 processes had finished. Normal host
background activity was not controlled. [measurement.json](measurement.json) keeps the raw
samples, quartiles, executable/source hashes and comparator provenance.

| Workload | T68 baseline | Stator interp | QuickJS | PrimJS | Speedup over T68 |
| -------- | -----------: | ------------: | ------: | -----: | ---------------: |
| array    |       111.22 |         40.51 |   45.04 |  28.57 |            2.75× |
| closure  |        97.49 |         32.51 |   33.16 |  22.54 |            3.00× |
| fib      |       536.90 |        146.06 |  134.95 |  83.09 |            3.68× |
| loop     |       223.15 |        100.39 |   81.95 |  55.27 |            2.22× |
| objects  |       143.79 |         53.26 |   56.53 |  37.65 |            2.70× |
| sieve    |        64.42 |         22.28 |   24.11 |  18.02 |            2.89× |
| string   |        20.62 |         13.44 |   13.41 |   9.91 |            1.53× |

The performance Check exited **1**:

```text
Faster with non-overlapping interquartile ranges: 3/7
QuickJS target unmet: closure.ts, fib.ts, loop.ts, string.ts
```

Arrays, objects and sieving beat QuickJS with non-overlapping interquartile ranges. Closures
and strings overlap; recursion is about 8% slower and the numeric loop about 23% slower than
QuickJS. PrimJS is faster than the changed interpreter on all seven workloads. T70 remains
open; no `done.md` was written and its heading is not struck in `plan.md`.

Reproduce from this worktree (the baseline and comparator are local ignored build artifacts):

```sh
STATOR_ENGINE="$PWD/.cache/t70/final" \
STATOR_ENGINE_BASELINE="$PWD/.cache/t70/baseline" \
PRIMJS="$PWD/.cache/primjs/out/Default_snapshot/qjs" \
PRIMJS_VERSION=2.11.1-rc.1 \
PRIMJS_REVISION=941a365bfec2afc709488a4ec8dcb3eba962e1a3 \
PRIMJS_BUILD_ARGS='target_cpu="arm64" is_debug=false mac_deployment_target="11.0"' \
BENCH_RUNS=15 mise exec -- pnpm run engine:bench:quickjs --require-faster
```

The remaining performance work needs profiling of the optimized call/frame path, numeric loop
and string allocation costs. More aggressive call-helper inlining already lost on recursive
performance; it is not an evidence-backed route to closing this gap.
