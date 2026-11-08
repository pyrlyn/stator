---
status: in progress
priority: P2
complexity: 3
readiness: 100%
agent: Claude Code / claude-opus-5-5
---

# T65. Type-check the repository with stator-ts instead of `tsc`

The creator asked to replace `tsc` with stator-ts (`packages/transpiler`). `pnpm run typecheck`
runs `tsc --noEmit` over five tsconfigs and `pnpm run build` runs `tsc -p packages/compiler`.
T59 showed `stator-ts check` reporting 0 errors on `packages/compiler`, `node`, `std`, `tests` and
`vite-stator`, as `tsc` does. The compiler's own use of the `typescript` API is T41's, not this
task's. Bun is not a tool of this repository (only a benchmark competitor and a `--runtime` choice
of `stator-ts test`), so there is nothing of it to replace here.

Done means `typecheck` runs `stator-ts check` on the five projects, CI builds stator-ts first,
and a planted type error fails the gate the way `tsc` does.

Check: `pnpm run typecheck` passes on `main` and fails on a planted TS2322 in each of the five
projects; `pnpm run ci` passes.

Execution plan:
1. Run `stator-ts check` on the five projects; fix in `packages/transpiler` every error `tsc`
   does not report, each with a fixture checked by `tests/differential.sh` against tsc 7.
2. `scripts/typecheck.ts`: build stator-ts (`zig build -Doptimize=ReleaseSafe`, or `STATOR_TS`),
   then `check -p` each project; `pnpm run typecheck` and the moon `typecheck` tasks call it.
3. CI: `.github/actions/setup` installs Zig on Windows too, since every frontend leg runs
   `typecheck`.
4. Docs: `AGENTS.md`, `docs/TOOLCHAIN.md`, `toolchain.md`.
5. Verify: planted TS2322 per project fails the gate; `zig build test`, `tests/differential.sh`,
   the TS7 ratchet and `pnpm run ci` pass.
