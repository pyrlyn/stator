---
status: todo
priority: P2
complexity: 2
readiness: 0%
agent:
---

# T38. C compiler driver detection

Steps:
1. Replace the hard-wired `clang` in `build.ts` with a resolver: `--cc` / `STATOR_CC` / `CC`,
   then `clang`, `cc`, `gcc` on `PATH` (V order: `-cc`, then system cc; a bundled tcc is a
   later option, not in this card).
2. Probe once per build (`--version`), map flags per family (clang/gcc; `-flto`, ASan, `-O`),
   refuse unknown families with a named diagnostic.
3. Keep the macOS ASan `/usr/bin/clang` override (plan-notes for conda-clang 21.1.8).

**Check:** goldens pass with `STATOR_CC=gcc` on Linux and `STATOR_CC=clang`; `STATOR_CC=/bin/false`
gives the named diagnostic, not a stack trace.
