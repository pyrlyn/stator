# TOOLCHAIN.md

The pinned toolchain (plan.md §4 Task 1.0 step 2). Differential ground truth is the Node in
`.node-version` — **that Node and only that Node**. Record any change here in the same commit
that changes the pin, and note the reason in `plan-notes.md`.

## Pinned

| Tool                      | Pin                | Where pinned                                                                                                                                                                                                                     |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                      | `26.7.0`           | `.node-version`, `engines.node >= 24` in `package.json`                                                                                                                                                                          |
| TypeScript                | `6.0.3` (exact)    | `dependencies` in `packages/compiler/package.json`                                                                                                                                                                               |
| TypeBox (`typebox`)       | `1.3.36` (exact)   | `dependencies` in `packages/compiler/package.json`. `stator.config.json`: the schema, its `Config` type and validation from one source; `src/cli/config.ts` only (plan-notes 303)                                                |
| jsonc-parser              | `3.3.1` (exact)    | `dependencies` in `packages/compiler/package.json`. Locates a `stator.config.json` syntax error (line, column) in strict mode; `src/cli/config.ts` only (plan-notes 303)                                                         |
| `@types/node`             | `26.6.3` (exact)   | `devDependencies`                                                                                                                                                                                                                |
| oxlint                    | `1.86.0` (exact)   | `devDependencies`                                                                                                                                                                                                                |
| oxlint-tsgolint           | `7.0.2003` (exact) | `devDependencies`. The type-aware backend `oxlint --type-aware` runs through (plan-notes 224).                                                                                                                                   |
| oxfmt                     | `0.71.0` (exact)   | `devDependencies`                                                                                                                                                                                                                |
| cpd (copy/paste detector) | `5.4.0` (exact)    | `devDependencies`. `.jscpd.json`: our source only (tests, vendor, docs excluded), identifier-insensitive, AI reporter; fails on any clone not in `.jscpd-baseline.json` (AGENTS.md golden rule 10) |
| vitest                    | `5.0.3` (exact)    | `devDependencies` (root + `packages/tests`). Unit-test runner (plan-notes 285); `test:impact` picks its files from the impact map (plan-notes 293).                                                                                                  |
| c8                        | `12.0.0` (exact)   | `devDependencies`. `test:coverage`: V8 coverage across vitest workers and every CLI subprocess (plan-notes 285).                                                                                                                 |
| vite                      | `8.3.3` (exact)    | `peerDependencies` (`^8.3.2`) and `devDependencies` of `packages/vite-stator`; `devDependencies` of `examples/vite`. The default bundler adapter and the `stator()` plugin (T12.2, plan-notes 321). Bumped 8.3.1 → 8.3.2 with the creator's permission; the devDependency moved to 8.3.3 in #141 |
| vite-stator               | workspace          | `devDependencies` (root, `workspace:*`), so `--bundler=vite`, the default, resolves it. Never a dependency of `packages/compiler` (plan §0.9) |
| pnpm                      | `12.3.4`           | `packageManager` in root `package.json`, `npm:pnpm` in `mise.toml`                                                                                                                                                               |
| LLVM                      | `21.1.8`           | `mise.toml` (`conda:llvm` + `conda:clang`, Unix). The C compiler the justfile and `packages/compiler/src/cli/build.ts` look up as `$CC`/`clang`. Conda prebuilts — the asdf llvm plugin compiles from source and is not the pin. |
| just                      | `1.58.0`           | `mise.toml`. The runtime build (`just -f packages/runtime/justfile -d packages/runtime runtime`, `runtime-asan`, `runtime-intl`).                                                                                                |
| Zig                       | `0.16.0`           | `mise.toml` (`zig`, Unix). The memory-core objects in `libjsrt.a` (plan-notes 238, T9.1) and the `std/*` backings in `libjsrt_std.a` (T11.2). CI install via `mlugg/setup-zig@v2` in `.github/actions/setup` (skipped on Windows, which never builds the runtime). |

Node ≥ 24 is required because dev runs the compiler's TypeScript sources directly
(`node packages/compiler/src/cli/main.ts`) via native type stripping — there is no build step in development.

TypeScript is deliberately **not** on `latest`: `latest` is now 7.x (the Go port / tsgo), whose
public compiler API plan.md §0.3 rules out. `6.0.3` is the newest stable 6.x. Re-evaluate
quarterly and record the outcome in `plan-notes.md`.

Dependabot (`.github/dependabot.yml`, plan-notes 212) proposes weekly bumps for the npm tree and
the GitHub Actions, and cannot keep the rule above by itself: a PR from its `toolchain` group moves
a row of this table, so it needs that row and a `plan-notes.md` line before merge. It never
proposes a TypeScript or `@types/node` major. Node, pnpm, LLVM, just and Zig stay hand-bumped.

## Site (`site/`)

The landing page is its own Astro project with its own lockfile (`site/pnpm-lock.yaml`), built and
checked by `.github/workflows/pages.yml`, never by `pnpm run ci`. That workflow publishes only when
the repository has a GitHub Pages site; otherwise it still builds and checks, and skips the deploy.

| Package                     | Pin                | Where pinned                                                                                                                                         |
| --------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| astro                       | `^7.3.5`           | `dependencies` in `site/package.json`. The static site build and its `<meta>` CSP (`security.csp`)                                                   |
| `@fontsource/ibm-plex-sans` | `5.3.0` (exact)    | `dependencies` in `site/package.json`. Self-hosted IBM Plex Sans (OFL-1.1), so a visit requests nothing from a third party (Task 6.26, plan-notes 336) |
| `@fontsource/ibm-plex-mono` | `5.3.0` (exact)    | `dependencies` in `site/package.json`. Self-hosted IBM Plex Mono, as above                                                                           |
| playwright-core             | `1.63.0` (exact)   | `devDependencies` in `site/package.json`. `pnpm run check:browser` drives the installed Chrome over `dist/`; downloads no browser (plan-notes 336)   |

## Verified development host

The host this bootstrap was verified on (a data point, not a requirement):

```
node    v26.7.0
clang   Apple clang version 21.0.0 (clang-2100.1.1.101), arm64-apple-darwin25.5.0
just    1.58.0
git     2.50.1 (Apple Git-155)
os      Darwin 25.5.0 arm64
```

CI must run at least ubuntu-latest and macos-latest (plan.md §4 Task 1.0 step 10).

## Commands

```
pnpm install --frozen-lockfile   # install exactly the pinned tree
pnpm run ci                      # typecheck -> lint -> dupes -> unit -> runtime -> subset -> golden -> leak -> asan
pnpm run test                    # unit tests via vitest (the default; coverage is on-demand, not per-run)
pnpm run test:impact             # only the tests your diff reaches, every harness (plan.md §9 Task 6.17); prints its reasons, falls back to the full run
pnpm run test:impact:record      # record that map: a full instrumented run at a clean HEAD → .cache/impact/impact-map.json
pnpm run test:coverage           # unit tests + src/ coverage table; writes coverage/lcov.info (only when the table is the question — ~4x wall time)
pnpm run test:subset             # feature × mode decision matrix
pnpm run test:golden             # compile + run vs the pinned Node, byte-for-byte
pnpm run test:selfhost           # Stator explains (and builds) its own packages; per-code counts may only shrink
pnpm run test262                 # Test262 slice against the pin in tests/test262/pin.json
pnpm run test:node-suite         # Node's own test/parallel slice (tests/node-suite/pin.json) through vitest
pnpm run differential            # fuzzer vs Node (failures land in packages/tests/differential/failures/)
pnpm run bench:record            # refresh packages/tests/bench/baseline.json (this machine only)
just -f packages/runtime/justfile -d packages/runtime runtime          # packages/runtime/build/libjsrt.a          (clang -O2, -Werror; thin LTO where the linker allows)
just -f packages/runtime/justfile -d packages/runtime runtime-asan     # packages/runtime/build-asan/libjsrt.a     (-fsanitize=address,undefined -O1 -g)
just -f packages/runtime/justfile -d packages/runtime runtime-intl     # packages/runtime/build-intl/libjsrt.a     (ICU feature build)
just -f packages/runtime/justfile -d packages/runtime runtime-test     # print corpus vs Node, then tests/roots.c
just -f packages/runtime/justfile -d packages/runtime runtime-clean
just -f packages/std/justfile -d packages/std std                    # packages/std/build/libjsrt_std.a        (zig -O ReleaseSafe; `pnpm run runtime` builds it too)
node packages/compiler/src/cli/main.ts build file.ts -o app [--mode=ts|js]
node packages/compiler/src/cli/main.ts explain file.ts --json
```

Release and sanitized runtime archives build into **separate** directories (`packages/runtime/build/` and
`build-asan/`) so a sanitized archive can never be linked into a release binary by accident.

Release links dead-strip (Task 3.12): builtins live in `libjsrt.a` compiled with
`-ffunction-sections -fdata-sections`, and the final link passes `-Wl,-dead_strip` (Mach-O) or
`-Wl,--gc-sections` (ELF), so a builtin the program never references is not in the binary —
function granularity, not the archive's .o granularity. Sanitized builds skip the stripping:
ASan's global-registration sections are exactly what `--gc-sections` is documented to drop.

Release archives are thin-LTO bitcode where the toolchain can link one (plan-notes 162): `just -f packages/runtime/justfile -d packages/runtime runtime` probes `-flto=thin` through `$CC`/`$AR` and records the flag in `packages/runtime/build/link-flags.txt`, so
the CLI's single clang call compiles the generated C to bitcode too and the runtime's accessors and
builtins inline across the archive boundary. ld64 and lld read bitcode archives; GNU ld needs the
LLVMgold plugin, and without it the probe fails and the archive is plain objects, reported on the
recipe's status line. Sanitized builds never use LTO. A probe result or Boehm status that differs
from the last build rebuilds every object (`packages/runtime/build*/cflags.txt`).

## CI stages (`.github/workflows/ci.yml`)

CI runs in two stages (plan-notes 292):

1. **Stage 1, Linux only:** `static analysis` (typecheck, `lint` = oxlint `--deny-warnings` + oxfmt
   check, `dupes`, then jactionlint 2.0.2 over the workflows against `.github/jactionlint-baseline.json`
   and the durable ignores in `.github/jactionlint.yaml`) and `frontend (linux/x64)` (subset tests, runtime archive, unit tests **with
   coverage**; uploads the `coverage-lcov` artifact). This is the only job that collects coverage.
   The two `pyrlyn/ci` `@main` callers stay unpinned: pinning them fails `no-pinned-ci` (plan-notes 362).
2. **Stage 2, Windows and macOS:** `frontend-desktop` (macOS and Windows, plain `pnpm run test`),
   plus the `-macos` twins of `runtime`, `asan`, `intl` and `ffi`. Each has
   `needs: [static, frontend-coverage]`, so none starts unless every stage-1 job passed.

Other Linux jobs (`test262`, Linux arm64 `frontend`, Linux `runtime`/`asan`/`intl`/`ffi`) belong to
neither stage and run ungated, in parallel with stage 1.

## Compile-time opt level (`STATOR_OPT` / `--opt`)

The final clang link of generated C defaults to `-O2` (non-asan). Override per build:

```
STATOR_OPT=0 node packages/compiler/src/cli/main.ts build file.ts -o app   # faster iterate
node packages/compiler/src/cli/main.ts build file.ts -o app --opt=3         # max clang opts
```

`--opt` wins over `STATOR_OPT` when both are set. A `STATOR_OPT` outside `0`–`3` is `STA0002`,
and the message names the environment variable, since no `--opt` is on the command line. ASan builds ignore this and keep `-O1 -g
-fsanitize=…`. The release runtime archive may already record `-flto=thin` in
`packages/runtime/build/link-flags.txt`; `extraLinkFlags()` picks that up so the generated C is
compiled as thin-LTO bitcode too when the archive was. Full PGO / a custom LLVM backend remains
§12 rung 6 and needs the Task 6.3 measurement gate before it is scheduled.

## Environment variables and `.env`

`stator build` and `stator explain` read these from the environment:

| Variable | What it picks | May a project `.env` set it? |
| --- | --- | --- |
| `STATOR_OPT` | clang `-O` level (above) | yes |
| `STATOR_RUNTIME` | runtime flavor: `asan` or `intl` archive, and the builtins the gate admits | yes |
| `STATOR_OTEL` | turns tracing on (plan-notes 187) | yes |
| `CC` | the C compiler Stator runs | **no** |
| `STATOR_RUNTIME_ROOT` (and `STATOR_STD_ROOT`, `STATOR_NODE_ROOT`) | where the runtime headers and archives live | **no** |
| `OTEL_*` (`OTEL_EXPORTER_OTLP_ENDPOINT`, `_HEADERS`, `OTEL_SERVICE_NAME`, …) | where trace data goes | **no** |

The CLI reads `./.env` from the **current directory**, which is the project being compiled and
may be a repository someone else wrote. So the file may set only the three build options above.
The programs Stator runs and the place its telemetry goes come from the real environment, never
from the input tree (plan.md §9 Task 6.21, QA audit F4). A real variable always wins over the
file. When the file applies a key, or holds `CC`, `STATOR_*` or `OTEL_*` keys it may not set, one
stderr line says so: `stator: .env: applied STATOR_RUNTIME; ignored CC (only STATOR_OPT,
STATOR_RUNTIME, STATOR_OTEL may come from .env)`. Other keys in the file are not read.

The runtime flavor and root are resolved once per `build()` call, after `.env` is applied, and
the gate and the link use that one value: `STATOR_RUNTIME=intl` in `.env` either links the ICU
archive or fails with `STA0011` when it is not built, exactly as the real variable does (QA audit
F3). A `CC` that exits 0 without writing its output is `STA0009`, not a successful build.

## Native libraries

None of these come from the npm tree. Vendored sources live in the repo and build with the runtime;
system libraries are discovered at runtime-build time and recorded in `packages/runtime/build*/link-flags.txt`, which
`packages/compiler/src/cli/build.ts` reads back — so the emitted program links exactly what the archive it links was
compiled against (plan-notes 106).

| Library                                              | Kind                            | Required                     | For                                                                                                                | Discovery / install                                                                        |
| ---------------------------------------------------- | ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| QuickJS-NG `libregexp` (+ `libunicode`, `cutils.h`)  | vendored, MIT                   | yes                          | the RegExp engine (golden rule 5)                                                                                  | `packages/runtime/vendor/quickjs-ng/` — provenance in its `VENDOR.md`                      |
| fdlibm (V8 `ieee754.cc`, mechanically ported to C11) | vendored, fdlibm + BSD-3-Clause | yes                          | `Math.sin` and 19 siblings, bit-identical to the pinned Node's                                                     | `packages/runtime/vendor/fdlibm/` — provenance in its `VENDOR.md`                          |
| libm (`-lm`)                                         | system                          | yes                          | `floor`/`trunc`/`sqrt`/`fmod` — ToInt32, array indexing, the print path                                            | part of libSystem on macOS (the flag is a no-op there), separate on glibc (plan-notes 122) |
| Boehm GC (`bdw-gc`)                                  | system                          | optional                     | the collector (`docs/VALUE.md` §4.12); without it the runtime falls back to plain `malloc`, no collection          | `pkg-config --libs bdw-gc`; macOS `brew install bdw-gc`, Debian `apt install libgc-dev`    |
| ICU (`icu-uc`, `icu-i18n`)                           | system                          | optional, feature build only | `Intl` — `just -f packages/runtime/justfile -d packages/runtime runtime-intl`, into `packages/runtime/build-intl/` | `pkg-config`; macOS `brew install icu4c`, Debian `apt install libicu-dev`                  |

The default archive is byte-identical whether or not ICU is installed on the host — that is why
Intl is a separate object directory rather than a flag on the default build.

Vendored code compiles with `-Wall` alone rather than the runtime's `-Wall -Wextra -Werror`
(plan-notes 101) and is never hand-edited. A version bump is `pnpm run vendor:update <name> [ref]`
(`packages/runtime/vendor/update.mjs`): it refetches the manifest's files at that ref — re-running `port.mjs`
over upstream's `ieee754.cc` for fdlibm — and prints the provenance rows for the directory's
`VENDOR.md`. `--check` validates the manifests offline. Re-vendoring at the pinned ref reproduces
the tree byte-for-byte, so `git status` after a run is the diff the bump actually introduces.

## Native tools

Beyond Node/pnpm (pinned above), the build shells out to:

| Tool            | Used by                                                              | For                                                      |
| --------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `clang` (`$CC`) | justfile, `packages/compiler/src/cli/build.ts`, `src/cli/library.ts` | the runtime, the emitted C, the final link, and the `--emit=lib` prelink (`cc -r`) |
| `ar` (`$AR`)    | justfiles, `packages/compiler/src/cli/library.ts`                    | archiving `libjsrt.a` and `libjsrt_std.a`; the `--emit=lib` archive (`ar rcsD` on ELF, `ZERO_AR_DATE=1 ar rcs` with Apple's `ar`, so it is byte-reproducible; plan.md §10 Task 7.4). Missing or failing under `--emit=lib`: `STA0020` |
| `objcopy` (`$OBJCOPY`) | `packages/compiler/src/cli/library.ts`, ELF only               | `--emit=lib`: `--keep-global-symbols` makes the private runtime's symbols local (GNU binutils or `llvm-objcopy`; macOS needs none, its linker localizes). Missing or failing: `STA0020` |
| `pkg-config` (consumer side) | a C build using an `--emit=lib` library              | `pkg-config --cflags --libs lib<name>` reads the emitted `.pc` (docs/FFI.md §8); the CI check `static-lib.ts` uses it |
| `just`          | justfile                                                             | the runtime build (pinned `1.58.0` in `mise.toml`)       |
| `zig`           | justfiles (T9.1, T11.2)                                              | memory-core objects into `libjsrt.a`, std backings into `libjsrt_std.a` (pinned `0.16.0` in `mise.toml`; required) |
| `pkg-config`    | justfile                                                             | finding bdw-gc and ICU; absent means both are simply off |
| `diff`          | `just -f packages/runtime/justfile -d packages/runtime runtime-test` | the print corpus against Node, byte-for-byte             |
| `nm`            | `packages/tests/impact/` (`test:impact:record`)                      | which `libjsrt.a` members a test's binary linked (Task 6.17); a missing `nm` records "all of the runtime" |
| `git`           | `packages/tests/impact/` (`test:impact`)                             | the diff against the impact map's commit                  |

`clang` (and the rest of LLVM) and `zig` 0.16.0 are `mise install` on Unix. The others still come from the Xcode
command-line tools (`xcode-select --install`) on macOS and from `binutils`/`pkg-config`/
`diffutils` on Debian/Ubuntu. A missing compiler is a diagnostic with the install hint (`STA0008`),
not a crash.

### macOS SDK fallback for a stale bundled linker

The pinned conda clang ships its own `ld`, which can lag the installed Xcode SDK: when the
SDK's `.tbd` files name arch variants the bundled `ld` cannot parse, every Darwin link
fails. The CLI link (`packages/compiler/src/cli/build.ts`), the justfile's `runtime-test`
corpus link, and the test-side consumer links (export-stubs, the FFI C-consumer) all handle
this the same way — one retry under the newest Command Line Tools SDK the old parser can
still read (`packages/compiler/src/support/toolchain.ts`), only after a failure carrying
that exact signature, never for an explicit `CC`. Green-path cost is zero; nothing is
recorded in `link-flags.txt`. Do not rebuild the runtime archive (`just runtime`) while a
golden run is linking against it — `ar` rewriting `libjsrt.a` mid-link surfaces as a
transient `library not found for -ljsrt` in exactly one fixture.

## Not yet required

These arrive with the phase that needs them; do not add them to CI before that:

- **Ryū** — **NOT vendored.** Planned by Phase 2 Task 2.5 for `runtime/vendor/ryu/`; it was never fetched, and `shortest_digits()` in `runtime/src/jsrt_print.c` stands in for it with a round-trip search over `%.*e`. Correct, and slow: up to 18 `snprintf`+`strtod` pairs per number printed. See plan-notes 28 for the standing seam and plan-notes 188 for the correction: the network IS reachable, so Ryū is fetchable and simply not yet fetched — a scheduling fact, not an environmental one. **The schedule is now recorded** (owner's call, 2026-09-04, plan-notes 190): Ryū rides the §12 optimization ladder rather than becoming a task, because the corpus it would replace already matches Node byte-for-byte, so it is a pure speed change and §12's entry criterion — a measured before/after on Task 6.3's harness — applies. (This line claimed Ryū was vendored until 2026-09-01.)
- **Test262 corpus** — fetched on demand (`pnpm run test262:fetch`) into `tests/test262/corpus/` or `$STATOR_TEST262`. The runner, pin, and ratchet are in-tree; `pnpm run test262` is a CI heartbeat, not part of `pnpm run ci`.
- **Node test suite corpus** — the `test/parallel` files `tests/node-suite/expectations.json` selects, fetched from the tag in `tests/node-suite/pin.json` (the `.node-version` Node) into `tests/node-suite/corpus/` or `$STATOR_NODE_SUITE` by `pnpm run test:node-suite`, which then runs them through vitest (plan.md §11c T11.7). Not part of `pnpm run ci` (it needs the network); `ci` checks the expectations file's shape in `unit/node-suite.test.ts` and its counts in `docs/NODE.md`.
  - **Pool width (`STATOR_TEST_JOBS`)** — `packages/tests/support/parallel.ts` runs compile/execute work on a fixed-size pool. Default width is `os.availableParallelism()` (one slot per logical core). Set `STATOR_TEST_JOBS=N` to override: raise it on a quiet machine with headroom, lower it (`1` forces serial) when debugging a flaky failure or when sharing a CI box that must not be saturated.
  - **Results JSON** — compact by default; `--pretty-results` or `STATOR_TEST262_PRETTY=1` for indented output. `STATOR_TEST262_WRITE_RESULTS=0` skips writing the big file for local scratch (CI shards must still write — leave unset there).
