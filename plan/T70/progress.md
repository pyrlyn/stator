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

## Continuation after PR #293

The creator expanded the target to wins against **both** QuickJS and PrimJS on all seven
unchanged programs. `--require-faster` now requires a PrimJS executable and rejects any row
whose interpreter p75 is not below both competitor p25 values. Historical measurements above
remain the record of the first patch; they do not describe the continuation.

Work starts from `e38c2a89`. The comparator is rebuilt from the same PrimJS commit and release
arguments recorded above. The baseline binary is preserved locally during iteration. Exploratory
interleaved runs are used to accept or reject changes; a final measurement must follow the builds
and correctness checks, with source and binary hashes matching the tested tree.

Profiles of scaled copies (not replacements for the committed programs) found recursive-call
window preparation and VM dispatch, numeric-loop dispatch, property write barriers, and repeated
ToPrimitive/ToString calls on strings. The continuation reuses the existing Int32 value tag,
property ICs, collector, concatenation implementation, bytecode compiler and baseline JIT.

A startup `JSRT_GC_STRESS=1` experiment panics with a negative collector count on both the
unchanged `e38c2a89` binary and the changed binary. It is not evidence of a new regression or a
passing stress gate. A focused regression test instead explicitly collects after initialization
while interpreted callers and native callback reentry hold live objects.

The Int32 path exposed a runtime JSON serializer that still recognized only doubles. The same
change now uses the shared Number predicate/accessor and tests nested Int32 values, limits,
negative zero and mixed doubles. `engine:test` on the resulting CLI reports `54 passed, 0 failed`.
The explicit string-buffer transition/concurrency regression and the existing `std` tests report
`23 passed`. The interpreter/JIT Zig tests pass in ReleaseSafe. An intermediate Test262 run
retains `14654 / 23726 pass (61.76%)`, with the baseline's 24 crashes and no timeouts; this is a
ratchet result, not full language conformance. These are iteration checks, not the final gate.

T70 remains open until the expanded performance Check and all correctness checks pass.

## Continuation publication (2026-11-08)

This continuation is integrated with `379802a0` (T71–T73), preserving the JIT remainder
optimization and the collector's owner-lookup reuse. It implements iterative synchronous call
frames, compact call opcodes and parameter initialization, Int32 arithmetic, combined bytecodes,
non-throwing cached reads, primitive-only barrier elision and the existing collector's
single-thread fast path for allocation and string append. Both interpreter and JIT retain the
slow paths for coercion, TDZ, getters, exceptions and constructors. Regression tests explicitly
collect with suspended callers and native reentry and exercise the first worker transition.

The benchmark now requires PrimJS for `--require-faster`. Its source diff includes both staged
and unstaged changes, so the executable's recorded provenance survives staging for publication.
No benchmark program or conformance baseline changed. The initial publication measurement used
the ReleaseSafe CLI left by `engine:test`; it was discarded and is not the measurement below.

### Correctness checks

On the integrated tree, `mise exec -- pnpm run ci` exited 0:

```text
Test Files 66 passed (66)
Tests 841 passed (841)
subset: 1041 fixtures — 1010 passed, 31 expected-fail, 0 failed
golden: 525 fixtures — 525 passed, 0 failed
runtime: print corpus matches Node (ASan/UBSan)
ffi static-lib: ok (asan, two libraries, two collectors collecting on every allocation)
golden: 525 fixtures — 525 passed, 0 failed
asan: golden-asan green
```

The four leak checks plateaued below 65,536 KB (peak RSS 12,448 / 12,624 / 12,592 / 16,000 KB).
The ordinary and ASan golden runners each skipped the two ICU-only fixtures. The full unit suite
includes the new concurrency test; the ASan thread subset passed 7 tests with 16 unrelated tests
skipped. Type checking, lint, formatting and duplication checks passed (0 clones). After the
benchmark provenance correction, its targeted lint and formatting checks also passed.

`mise exec -- pnpm run interp:test` exited 0. `mise exec -- pnpm run engine:test` reported
`engine: 58 passed, 0 failed` on ReleaseSafe. After an explicit
`mise exec -- zig build cli -Doptimize=ReleaseFast --build-file packages/engine/build.zig`,
the same corpus using `STATOR_ENGINE` reported `engine: 58 passed, 0 failed` on the exact
ReleaseFast executable measured below.

`STATOR_TEST262=<pinned corpus> mise exec -- pnpm run test262:interp-exec` exited 0:

```text
test262-exec: 14654 / 23726 pass (61.76%)
not run: 817 module tests; unsupported constructs in 1280 tests; 0 timeouts; 24 crashes
test262-exec: 3 directories pass more than the baseline; record them with --update
```

This remains a ratchet result with known unsupported cases and crashes, not full conformance.

### ReleaseFast performance

[continuation-measurement.json](continuation-measurement.json) contains 15 interleaved samples
per engine/program, quartiles, unchanged input hashes, source diff and executable provenance.
Apple M3 Max, macOS 27.0.1, Node v26.7.0, Zig 0.17.1; wall milliseconds including startup after
one untimed repetition. This task's builds and tests had finished; ordinary host background
activity was not controlled. QuickJS 2026-06-04 and PrimJS 2.11.1-rc.1 use the provenance and
release arguments above. Every result matched the pinned Node stdout byte-for-byte.

The baseline is the saved `e38c2a89` ReleaseFast executable, SHA-256
`a742eccc3f3d19a16dda962d6eab655fc5b04825e3183d6bdd973dbe249ea06d`.
The measured continuation executable is SHA-256
`52312761e6e79ddefabe2c9beb35b6bad66cf7a0d0c92f4b14ea9fce20313246`.
The comparison includes the intervening main changes as well as this continuation.

| Workload | PR #293 baseline | Stator interp | QuickJS | PrimJS | Speedup over baseline |
| -------- | ---------------: | ------------: | ------: | -----: | --------------------: |
| array | 39.56 | 31.39 | 44.26 | 27.96 | 1.26× |
| closure | 31.67 | 25.03 | 32.32 | 22.36 | 1.27× |
| fib | 150.63 | 96.00 | 136.78 | 84.51 | 1.57× |
| loop | 102.27 | 48.97 | 83.33 | 56.50 | 2.09× |
| objects | 53.33 | 43.51 | 56.88 | 36.70 | 1.23× |
| sieve | 21.73 | 19.16 | 24.51 | 17.71 | 1.13× |
| string | 12.51 | 9.94 | 12.46 | 8.84 | 1.26× |

Reproduction uses the command above with
`STATOR_ENGINE="$PWD/packages/engine/zig-out/bin/stator-engine"` after the explicit ReleaseFast
build, the preserved baseline and `BENCH_RUNS=15`. The performance Check exited **1**:

```text
Faster with non-overlapping interquartile ranges: 1/7
QuickJS/PrimJS target unmet: array.ts, closure.ts, fib.ts, objects.ts, sieve.ts, string.ts
```

The continuation improves every baseline median. Only the numeric loop satisfies the required
win against both competitors. PrimJS remains ahead on the other six medians. **T70 remains open**;
this is a publishable performance increment, not completion of the all-workload target.
