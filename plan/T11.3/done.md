# T11.3. Closing report

**Phase 11 — T11.3 the N1 `std` modules ✅ (2026-10-02)**

**Landed 2026-10-02** in three PRs (plan-notes 309; changelog v4.28, v4.29, v4.30), with T11.3a
(plan-notes 311) between steps 1 and 2.

- **Step 1** (#70): `std/os` and `std/io`. `std/io` calls libc directly, so a bad descriptor is
  `EBADF` rather than a Zig panic, and a write flushes C stdio first. Its bytes first crossed a
  byte channel; T11.3a replaced that with the extern table's `Uint8Array` row.
- **Step 2** (#71): `std/encoding` (Node's `Buffer` conversions; bytes-to-text through the
  backing, in NUL-free runs) and `std/hash` (Zig's `std.crypto` digests, `std.Io` secure
  random), both over the row.
- **Step 3**: `std/process` gains `argv`, `execPath`, `platform`, `arch`, `ppid`, `hrtimeNs`,
  `memoryUsage`, `exitCode`/`setExitCode`. The emitter's `main` takes `argc`/`argv` and returns
  the runtime's exit-code slot (`packages/runtime/src/jsrt_process.c`). `std/fs` gains
  descriptors (`open`/`read`/`write`/`close`), `readBytes`, `readdir`, `realpath`, `utimes` and
  `exists`.

**Check evidence:**

- **A golden per module against Node's equivalent:** `std_os`, `std_io`, `std_encoding`,
  `std_hash`, `std_process` and `std_fs`, each against its `golden/std-oracle/` twin.
  `pnpm run test:golden` → 415 passed.
- **Nondeterministic results by unit-test ranges** (`unit/std.test.ts`, 14 tests):
  `randomBytes` draws are fresh and cover all 256 byte values; `pid`, `ppid` (the spawning
  process), `execPath` (the binary's real path), `hrtimeNs` (a 20 ms sleep measures at least
  20 ms), `memoryUsage().rss` (1 MiB to 16 GiB) and `hostname` (Node's `os.hostname()`).
  Real arguments, a non-zero `setExitCode`/`exit`, an uncaught throw's status 1 and `abort` are
  there too, since the golden runner passes no arguments and demands status 0.
- **Subset rows in both modes:** `pnpm run test:subset` → 821 fixtures, 786 passed,
  35 expected-fail, 0 failed; `subset_std_{os,io,encoding,hash,process,process_n1,fs,fs_fd}_ts`
  and `_js` are all static except `std/hash`'s, which are dynamic (the `Uint8Array | string`
  union, STD.md §5).
- **Rest of `pnpm run ci` (exit 0):** typecheck and lint clean; `cpd` 206 clones (one fewer:
  the two async entries share `emitAsyncModuleRun`); vitest 51 files, 688 tests; selfhost matches
  its baseline; `builtins` 242/304; `docs/NODE.md` current; leak plateau; `golden-asan green`.

The card as it stood in plan.md:

The stub `plan.md` kept when the task closed:

~~**T11.3. `packages/std`: the N1 modules.**~~ ✅ **landed 2026-10-02** — evidence above (plan-notes 309).
