# T35. Done

Landed in three PRs:

- **#274** (`t35-choose-cc`):
  - `--cc`, the config key `cc` and `CC`, in that precedence, ahead of the default `clang`
    (`packages/compiler/src/cli/cc.ts`).
  - A `--version` probe that classifies clang, Apple clang and gcc and refuses anything else with
    `STA0022`. Flags pass through a per-family table, so gcc refuses `-flto=thin` by name.
  - The `link/clang` span is renamed `link/cc`.
  - `docs/TOOLCHAIN.md`, `docs/CONFIG.md`, `docs/DIAGNOSTICS.md` and the config schema updated.
  - The non-required `gcc goldens` CI job.
- **#280**: gcc 15.2 on x86_64 stopped the runtime build on three `-Werror` diagnostics clang does
  not emit: `-Wformat-truncation` in `jsrt_date.c` and `jsrt_print.c`, and `-Wdangling-pointer`
  in `jsrt_regexp.c`. None was a real overflow or dangling use; the code now states the bounds gcc
  cannot infer.
- **This change**: the regexp stack base comes from `__builtin_frame_address(0)` instead of a
  local's address, which SonarCloud (`c:S946`) and CodeQL (`cpp/stack-address-escape`) still read
  as a dangling reference after #280.

## Check

- `CC=gcc pnpm run test:golden` on Linux: `golden: 518 fixtures — 518 passed, 0 failed`.
  - Run in an `ubuntu:26.04` container on Colima (linux/arm64), `gcc (Ubuntu 15.2.0-16ubuntu1)
    15.2.0`, Node 26.7.0, Zig 0.17.1, just 1.59.0, with `CC=gcc pnpm run runtime` first.
  - gcc was the only C compiler in the container.
  - The `gcc goldens` CI job (x86_64, same gcc) builds the runtime green on #280. Its golden step
    is skipped while `SKIP_CI_TESTS` is set, so the container run is the evidence for that step.
- `stator build --cc=nope packages/tests/golden/ts/abstract_accessor.ts -o …` exits 1 with
  `STA0022 C compiler "nope" (from --cc) not found — …` and no stack trace.
  - The card names `examples/hello`, which does not exist in the tree; any entry reaches the probe
    first.
- `rg -n "'clang'" packages/compiler/src/cli` lists `cc.ts` only:
  - line 25, `DEFAULT_CC`;
  - lines 19 and 93, the family name in `CcFamily` and `classifyCompiler`.
  - No call site names the compiler. The macOS ASan override spells its path `/usr/bin/clang`.
- With clang on macOS:
  - `pnpm run test:runtime` matches Node;
  - `pnpm run test:golden` is 518/518;
  - `pnpm run test:asan` is green;
  - `pnpm run dupes` exits 0.
- A pattern nested 200,000 groups deep still throws `SyntaxError` and the program continues, as in
  Node, after the stack-base change.
