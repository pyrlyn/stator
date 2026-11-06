---
status: in progress
priority: P1
complexity: 4
readiness: 100%
agent:
---

# T11.2. `packages/std`: the real `std/*` package

Today `std/env` and `std/path` are golden fixtures over `declare` externs (plan-notes 284), not an
importable package. Steps: create `packages/std` (workspace member + moon project; `src/<module>.ts`
surface, `zig/<module>.zig` backings building `libjsrt_std.a`); the compiler resolves `std/*` to
it and links the library only when a program imports `std/*`; unknown `std/foo` stays a hard
error (STD.md §1); move `std/env` + `std/path` in; land T10.1 steps 3–4 (`std/process`, sync
`std/fs`, `std/time`) here. Update `docs/STD.md` (no longer a skeleton) and `packages.d2`.

**Check:** `std_env` / `std_path` goldens pass through `import … from 'std/…'` with no
`declare` fixture; T10.1's Check; a program without `std/*` imports links no `libjsrt_std.a`.

**Execution plan** (Claude Code / opus-5-5, branch `t11-2-std-package`):

1. `packages/std`: `package.json` (private workspace member), `moon.yml` (`build`, `typecheck`),
   `tsconfig.json` (Stator's own subset: es2025 lib, no Node types), `justfile` (`just std` →
   `build/libjsrt_std.a`, one Zig root `zig/jsrt_std.zig` importing one file per module,
   `zig fmt --check`, the runtime's Zig flags and macOS target rule). Surfaces in
   `src/<module>.ts`, their extern declarations in `src/native/<module>.d.ts`. `std/path` is pure
   TS (no backing, no leak — the 284 C shims leaked every result); `env`, `process`, `fs`, `time`
   are Zig over libc, returning C strings through one reused result buffer the emitter copies.
2. Compiler: `src/frontend/std.ts` owns the `std/` prefix — the package root (sibling package,
   `STATOR_STD_ROOT` override), the module list (the files in `src/`), and one classifier
   shared by the gate and the checker-diagnostic mapping: a known module resolves through a
   `paths` entry on the program's options; `std/sync` / `std/thread` are not-yet naming Phase 10
   (`STA1214`); any other `std/foo` is a hard error with a new `STA3002`. `cli/build.ts` links
   the archive (before `-ljsrt`; it calls only libc and has its own panic handler) only when the module graph holds a
   `std` file; a missing archive is `STA0011` naming the std recipe.
3. Tests: `std_env` / `std_path` goldens rewritten as `import … from 'std/…'` (their `declare`
   fixtures, C shims and `.mjs` shims deleted), new `std_process` / `std_fs` / `std_time` goldens
   and one js-mode golden. The Node oracle loads one TS resolve hook mapping `std/<m>` to a
   Node-backed oracle module, or to the real `packages/std/src/<m>.ts` when the module has no
   backing (path). Decision fixtures in both modes per module plus unknown / thread refusals;
   a unit test proves the link line carries `libjsrt_std.a` only for a `std` importer.
4. Wiring: pnpm workspace + lockfile importer, moon project + `std:build` edges, `pnpm run
   runtime` / `test:intl` / `test:asan` build the std archive too, root `typecheck` covers
   `packages/std`.
5. Docs: `docs/STD.md` (implemented, §8 questions answered), `SUBSET.md` std rows,
   `DIAGNOSTICS.md` (`STA3002`, `STA0011` scope), `packages.d2` + SVG, `TOOLCHAIN.md`,
   `AGENTS.md` repo map + commands, `README`s; plan-notes 294.
6. Verify with the full gate (tsc ×3, oxlint, oxfmt, cpd, vitest, subset, golden, builtins,
   node-coverage, `zig fmt --check`, runtime `-Werror` build, ASan gate), then move the record to
   `done.md` and leave the stub.
