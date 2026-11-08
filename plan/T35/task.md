---
status: in progress
priority: P2
complexity: 2
readiness: 90%
agent: Claude Code / claude-opus-5-5
---

# T35. Choose the C compiler: `--cc` / `CC` instead of hard-wired `clang`

Requested by the creator on 2026-10-25 (modelled on V's `-cc`). `packages/compiler/src/cli/build.ts`
calls `clang` by name for every compile and link; the only exception is the macOS ASan override to
`/usr/bin/clang` (conda-clang 21.1.8 deadlock). There is no way to pick another C compiler.

Steps:
1. **Resolver.** One function decides the C compiler, in this precedence: CLI `--cc=<name|path>` >
   `stator.config.json` `cc` (if the card adds it; `docs/CONFIG.md` + schema in the same change) >
   env `CC` > default `clang`. The macOS ASan override still applies only when nothing was chosen
   explicitly; an explicit choice under ASan prints a one-line warning instead.
2. **Validation.** Resolve the value on `PATH` (or as a path), run `<cc> --version` once per build,
   and classify the family (`clang`, `apple-clang`, `gcc`). Missing binary, non-zero exit, or an
   unknown family is refused with a new named diagnostic (`docs/DIAGNOSTICS.md`), naming the value,
   its source (`--cc`, `CC`, default) and how to fix it. No stack trace.
3. **Flags per family.** The flags `build.ts` passes today (`-O`, `-flto`, sanitizers, `--link=`
   passthrough) map through a per-family table; a flag a family lacks is refused by name, not passed
   blindly.
4. **One source of truth.** Every clang call site in `build.ts` (compile, `-c` for C-exposed units,
   link, parallel jobs) uses the resolved compiler; the chosen compiler and its source show in the
   `link/clang` trace span attributes (rename the span to `link/cc`).

Tests:
- Unit tests for precedence: `--cc` beats `CC`, `CC` beats the default, empty `CC` means unset.
- Unit tests for validation: missing binary, `CC=/usr/bin/false`, unknown `--version` output each
  give the named diagnostic and its fix text.
- Goldens pass with the default and with `CC=gcc` on the Linux CI runner (gcc installed there);
  with `CC=cc` on macOS.

Docs: `docs/TOOLCHAIN.md` gains a "C compiler" section: how it works (precedence, detection),
enable (`--cc`, `CC`) / disable (unset both, default `clang`), test commands, and limitations
(supported families, ASan override, no bundled tcc, Windows out of scope). `stator build --help`
lists `--cc`.

**Check:** `CC=gcc pnpm run test:golden` passes on Linux; `stator build --cc=nope examples/hello`
exits non-zero with the new diagnostic and no stack trace; `rg -n "'clang'" packages/compiler/src/cli`
shows only the default in the resolver and the ASan override.

**Blocked on nothing.**

## Execution plan

1. `src/cli/cc.ts`: `chooseCC` (precedence + macOS ASan override and warning), `detectCC`
   (`--version` probe, family, `STA0022`), the per-family refusal table.
2. `src/cli/config.ts` + schema: the `cc` key (relative to the file when it starts with `.`);
   `src/cli/main.ts`: `--cc` in FLAGS and `--help`.
3. `src/cli/build.ts`: every compile/link/prelink call takes the resolved compiler; span
   `link/clang` becomes `link/cc` with `cc.command`, `cc.source`, `cc.family`; runtime
   `link-flags.txt` and `--link` flags pass the family table.
4. Tests: `unit/cc.test.ts` (precedence, empty `CC`, override, classification, probe refusals),
   `unit/cli.test.ts` (`--cc` missing, `CC=/usr/bin/false`, unknown banner, `--help`),
   `unit/config.test.ts`.
5. Docs: `docs/TOOLCHAIN.md` "C compiler", `docs/CONFIG.md` row, `docs/DIAGNOSTICS.md` STA0022.
6. Verify: `pnpm run ci`; the Check's `--cc=nope` and `rg` commands; goldens with `CC=cc` on macOS;
   `CC=gcc pnpm run test:golden` on Linux (Colima or CI).
7. Linux gcc: the non-required `gcc goldens` CI job (`.github/workflows/ci.yml`) builds the
   runtime and runs `test:golden` with `CC=gcc`. The task closes with `done.md` once that job is
   green on the PR; until then the Check's first clause is unproven.
