---
status: in progress
priority: P2
complexity: 3
readiness: 100%
agent: Claude Code / claude-opus-5-5
---

# T30. Task 6.16 — clone baseline to zero

`.jscpd-baseline.json` is still debt (last measured **129** fingerprints after plan-notes 381;
the Check wants the baseline *empty*). Families still open per that note: `gate.ts`/`generics.ts`
`ts.is*` lists, array switch cases, `jsrt_string_ops`, `hir/verify`, `jsrt_print`, `jsrt_date`.

Steps:
1. One PR per family: extract the helper at the responsible layer (no `dupes` baseline growth
   in any commit; each PR runs `pnpm run dupes:baseline` and the file must shrink).
2. When the last family is gone, **delete** `.jscpd-baseline.json` and the `dupes:baseline`
   script path's baseline argument (or leave the script running with a missing/empty baseline —
   whatever `jscpd` treats as "no baseline"; document the choice in `AGENTS.md` golden rule 10).
3. Keep `pnpm run dupes` in `ci` green with zero clones.

**Check:** `pnpm run dupes` exits 0 with no baseline file (or an empty one); the clone count in
its output is 0; `pnpm run test` still green.

## Execution plan

1. List every clone (`cpd` with the baseline removed from the config, in a scratch copy).
2. Runtime C (`packages/runtime/src/`): extract shared static helpers or internal header
   helpers at the owning layer (`jsrt_*.h`), no behavior change; verify with
   `pnpm run runtime`, `test:runtime`, `test:golden`, `test:asan`.
3. Compiler (`packages/compiler/src/`): extract shared helpers in `frontend/`, `lower/`,
   `hir/`; verify with `pnpm run test`, `test:subset`, `test:golden`, `test:selfhost`.
   `src/cli/cc.ts` and `src/cli/config.ts` are being edited elsewhere; leave clones there.
4. Docs/examples (`docs/research/node-mode/scan.ts`, `examples/ffi/stat/stat_shim.c`).
5. After each step `pnpm run dupes:baseline`; the baseline only shrinks. Clones that cannot
   go without making the code worse stay, each listed with a reason in `done.md`; at zero,
   delete the baseline and document it in `AGENTS.md` golden rule 10.
6. `pnpm run ci`, then `done.md`, strike the heading in `plan.md`.
