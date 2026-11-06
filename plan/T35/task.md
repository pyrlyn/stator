---
status: todo
priority: P2
complexity: 2
readiness: 0%
agent:
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
