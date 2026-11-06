---
status: in progress
priority: P1
complexity: 3
readiness: 85%
agent: Claude Code / claude-opus-5-5
---

# T62. Build the Zig compiler on the in-repo stator-ts and share common Zig code

The creator asked that `packages/compiler-zig` and `packages/transpiler` use their common code, and
that it and other shared code move into `packages/`. `compiler-zig` still fetches stator-ts from
github.com/pyrlyn/stator-ts (#246 left that as a follow-up), and the copy in `packages/transpiler` is
stator-ts at `bd3c6f8` (its T19), older than the `9e992ea` (T20, the `stator_ts` library module and
`Session`) that `compiler-zig` needs.

Done means `packages/transpiler` is stator-ts at upstream `main`, `compiler-zig` depends on it by path,
Zig code duplicated between `compiler-zig`, `transpiler`, `runtime` and `std` lives once in a neutral
package under `packages/` (or one side calls the other), and the docs say so.

## Execution plan

1. Mirror stator-ts `bc7de36` (T20 and T21 merged) into `packages/transpiler`: `src/`, `tests/`,
   `scripts/`, `build.zig`, `build.zig.zon`, `mise.toml`, `AGENTS.md`, `toolchain.md`. Keep the
   in-repo `README.md` and `.gitignore`. Its T20 and T21 become T63 and T64 (T61 was taken).
2. `packages/compiler-zig/build.zig.zon`: `.stator_ts = .{ .path = "../transpiler" }`.
3. Find duplicated Zig code across the four Zig code bases; extract what is shared into
   `packages/<neutral-name>/` with its own `build.zig` and `build.zig.zon`, or make
   `compiler-zig` call what stator-ts already exports.
4. Update `docs/zig-core.md`, `plan/README.md` (stator-ts decisions), `toolchain.md`.

Check: `zig build test` passes in `packages/transpiler` and `packages/compiler-zig`, `zig build`
gives `statorc-zig`, `pnpm run zig-core:test` and `pnpm run dupes` pass, and
`packages/compiler-zig/build.zig.zon` names no URL.
