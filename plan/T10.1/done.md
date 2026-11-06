# T10.1. Closing report

**Phase 10 — T10.1 std low-level API ✅ (2026-10-02)**

**Landed 2026-10-02** (plan-notes 284, 294, 307). Steps 1–4 landed with T11.2 (`std/env`,
`std/path`, `std/process`, sync `std/fs`, `std/time` in `packages/std`, docs/STD.md). Step 5
closes the card: the Promise twins of the sync `std/fs` calls (`readTextAsync`,
`writeTextAsync`, `statAsync`, `mkdirAsync`, `unlinkAsync`, `rmdirAsync`) are `STA1214` naming
Phase 10 (T10.2's thread pool) in both modes, where before they were the checker's plain
"no exported member" (`STA0012`). The twin list is `THREAD_POOL_MEMBERS` in
`frontend/std.ts`; `stdImportRefusal` in `frontend/program.ts` maps TS2305/TS2724 on a twin to
it. Every other missing member keeps `STA0012`. No new diagnostic code.

**Check evidence:**

- goldens: `node packages/tests/golden/run.ts --filter std_` → 6 passed (`std_env`, `std_path`,
  `std_process`, `std_fs`, `std_time`, `std_js`), each against its `std-oracle` Node twin;
- subset rows match docs/SUBSET.md: `node packages/tests/subset/run.ts --filter subset_std` →
  17 passed, including `subset_std_fs_async_ts`/`_js` (not-yet `STA1214`) and
  `subset_std_fs_missing_ts` (error `STA0012`);
- no Node polyfill dependency: `packages/std/package.json` declares only a `typescript`
  devDependency;
- self-compilation: compiler `STA1214` 2549 → 2553, recorded with `--update` (plan-notes 306).

The card as it stood in plan.md:

The stub `plan.md` kept when the task closed:

~~**T10.1. `std` low-level API (sans threads).**~~ ✅ **landed 2026-10-02** — evidence above (plan-notes 284, 294, 307).
`std/env`, `std/path`, `std/process`, sync `std/fs` and `std/time` live in `packages/std`. The
`std/fs` Promise twins (`readTextAsync`, …) offload through T10.2 (docs/STD.md §2).
