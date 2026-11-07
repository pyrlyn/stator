# T66. Replace Boehm with pyrlyn/gc — done

## What was done

- **Toolchain.** Zig 0.16.0 → 0.17.1 (the minimum pyrlyn/gc declares) in `mise.toml`, CI,
  `AGENTS.md`, `docs/TOOLCHAIN.md` and `toolchain.md`; the runtime and std Zig sources ported.
- **Dependency.** `packages/runtime/build.zig.zon` pins pyrlyn/gc (`kxgc`, perceus) at an exact
  commit; the justfile fetches it into the git-ignored `packages/runtime/zig-pkg/` and compiles
  it into `libjsrt.a` with Stator's host module (`src/jsrt_gc_host.zig`). Row in `toolchain.md`
  (new "Zig packages" table).
- **Collector** (`src/jsrt_gc.zig`), as plan-notes 400 "As built" records: coalesced deferred
  reference counting (Levanoni–Petrank). `jsrt_gc_write(obj)` logs an object before its first
  mutation since the last collection; young objects are traced only if they survive; a zero-count
  table holds objects no heap reference names; suspects go to pyrlyn/gc's trial deletion. Roots
  are the precise `JSRT_FRAME` shadow stack plus a conservative scan of native stacks, registers
  and data segments. Stop-the-world at safepoints; `enter/leave_blocking` for threads.
- **Every kind** carries a header and vtable: Zig kinds through typed `gc.kind(T, …)` callbacks,
  C kinds through `JSRT_GC_KIND`, `JSRT_GC_VALUE_KIND` (fields named by offset, no trace
  function) and `JSRT_GC_TRACE`; every store into an existing object goes through
  `jsrt_gc_write`.
- **Boehm removed** from the justfile probes, link flags, CI (`libgc-dev`/`bdw-gc` installs gone;
  ASan jobs install `clang llvm` only), the `test:leak` skip, the FFI consumer (`two.c`) and the
  unit tests.
- **Debug modes:** `JSRT_GC_VERIFY=1` recounts every reference at each collection and aborts on a
  mismatch; `JSRT_GC_STRESS=1` collects on every allocation, reaching a `--emit=lib` library's
  private collector too.
- **Docs:** `docs/VALUE.md` §4.1 and §4.12, `HOW-IT-WORKS.md`, `DEVELOPMENT.md`, `THREADS.md`,
  `FFI.md`, `SELF-HOSTING.md`, `TOOLCHAIN.md`, `pipeline.d2` (+ SVG), `plan.md` (v4.90),
  plan-notes 400.
- **Clones:** the change removes more than it adds; `.jscpd-baseline.json` shrinks from 93 to 88
  fingerprints (one existing `jsrt_numeric.c`/`jsrt_value.c` include-list clone re-fingerprinted
  after unused includes were dropped).

## Deviations from the execution plan

- **No `JSRT_ENV_SET` codegen change (step 6).** Closure environments and generators are
  `always_dirty` kinds, reconciled at every collection, so generated stores into them need no
  barrier and `packages/compiler` / `packages/compiler-zig` are untouched.
- **Coalesced RC instead of a per-store retain/release barrier (steps 4–5).** One
  `jsrt_gc_write` per object per collection cycle instead of a count update per store.
- **No per-kind Zig unit tests (step 8).** Each kind's trace is checked against the barrier by
  running the whole golden corpus under `JSRT_GC_VERIFY=1`, and the FFI two-library test runs
  under `JSRT_GC_STRESS=1`.
- `docs/architecture/values.d2` needed no change: it draws boxing, not the collector.

## Check

Run in worktree `stator-t66` on macOS arm64. The lint step ran as `oxlint --deny-warnings .` plus
`oxfmt --check` over tracked and untracked non-ignored files, because the local git-ignored
`.claude/settings.local.json` is not project source; every other step is `pnpm run ci`'s.

```
88 clones · 1.4% duplication
Test Files  63 passed (63)
     Tests  816 passed (816)
subset: 1032 fixtures — 1001 passed, 31 expected-fail, 0 failed
golden: 505 fixtures — 505 passed, 0 failed
selfhost: 20 targets match the baseline
builtins: 258/324 surface members landed (80%), +5 nondeterministic (proved outside golden)
leak: 10M objects — peak RSS 12832 KB of a 65536 KB cap, 44 samples, plateau
leak: 10M FFI strings — peak RSS 12592 KB of a 65536 KB cap, 402 samples, plateau
leak: 2M computed-key reads — peak RSS 12944 KB of a 65536 KB cap, 26 samples, plateau
leak: 2M garbage cycles — peak RSS 16000 KB of a 65536 KB cap, 60 samples, plateau
ffi static-lib: ok (asan, two libraries, two collectors collecting on every allocation)
golden: 505 fixtures — 505 passed, 0 failed          (golden-asan)
asan: golden-asan green
CI-ALL-GREEN
```

Beyond the Check:

```
$ pnpm run test:ffi
ffi: 5 checks — 5 passed, 0 failed, 0 not run
$ JSRT_GC_VERIFY=1 node packages/tests/golden/run.ts
golden: 505 fixtures — 505 passed, 0 failed
$ git grep -nE 'JSRT_HAVE_BOEHM|[<"/]gc\.h|bdw-gc|GC_[a-z_]+\(' -- packages docs .github mise.toml toolchain.md ':!packages/tests/bench/memory/' ':!docs/research/'
(empty, exit 1)
```

Not measured: the collector's throughput against Boehm (plan-notes 400, "Not measured separately
yet"); the `intl_*` fixtures (ICU build, not part of `ci`).
