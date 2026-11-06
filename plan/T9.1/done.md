# T9.1. Closing report

**Phase 9 — Zig memory core ✅ COMPLETE (2026-09-16)**

*`plan.md` §11a. The Language & library boundaries table stays in `plan.md`: it is normative
(Zig never grows past the memory core without a new card). The `mlugg/setup-zig@v2` CI
install is still open for the creator (plan-notes 272) — CI runtime jobs fail at
`zig: command not found` until it lands.*

~~**T9.1. Runtime memory core in Zig**~~ ✅ Done — re-applied onto main (base `9f2eba4`) in
four commits, one per move step, **not** a merge of the stale `.worktrees/t9-1` planning
change (base `82d833f`-era, whose uncommitted tree also carried unrelated phase work).
The Zig root `packages/runtime/src/jsrt_mem.zig` builds one object, `jsrt_zig.o`, from
`jsrt_gc.zig`, `jsrt_buf.zig`, `jsrt_shape.zig` and `jsrt_alloc.zig`, declared for C in
`src/jsrt_mem.h`; `jsrt_gc.c` is deleted. The string ops have no growable buffer, so
nothing there moved. Property semantics stay in `jsrt_shape.c` and builtin-specific
constructors stay with their builtins. Two deliberate adaptations to main's drift since
`82d833f` (plan-notes 273): no `jsrt_shape_array_index` (the Zig ordering calls the
shared `jsrt_key_is_array_index` instead of carrying a second copy) and no
`jsrt_dynobj_new_class`/`bool dynamic` (that index-signature-class surface does not
exist on main).

**Check — PASSED** (2026-09-16, arm64 macOS, zig 0.16.0, Boehm, pinned Node 26.7.0):
`pnpm run ci` green end to end — typecheck/lint/dupes clean; unit 564/564; runtime
print corpus matches Node (rel and ASan/UBSan); subset 675 fixtures (637 passed,
38 expected-fail, 0 failed); golden 386/386 plain and 386/386 under ASan; leak plateaus
(10M objects 3664 KB peak, 10M FFI strings 3728 KB peak). "No C file still holds moved
code": every one of the 30 Zig exports is defined exactly once in `libjsrt.a`
(`nm`-checked), and `grep` finds only call sites left in C. `docs/TOOLCHAIN.md` lists
zig.

The stub `plan.md` kept when the task closed:

### ~~T9.1. Runtime memory core in Zig~~ ✅ — landed; record in `done.md` (§11a).
