# T33. Done

Steps 1–3 landed in #194 (021625fe, plan-notes 385): `packages/runtime/vendor/ryu/` pins Ryū
`v2.0` (`72e18e8d14d4392a4a3261f37cde248e4fbedbec`), `shortest_digits()` in
`runtime/src/jsrt_print.c` calls `d2s_buffered`, and `docs/TOOLCHAIN.md` records Ryū as vendored.

The last clause of the Check failed when this card was closed: re-vendoring from the pin
(`node packages/runtime/vendor/update.ts ryu`) changed `d2s.c` and `d2s_intrinsics.h`. #194 had
committed both with upstream comments rewritten (commented-out alternative code and two
explanatory comments replaced), a hand edit `VENDOR.md` forbids. The code was identical, so only
comments differed. This change commits the upstream bytes the script fetches, so a re-vendor is
now a no-op.

Branch: `t33-close-ryu`.

How it was checked, on a1ee0732 plus this change (macOS arm64):

- `node packages/runtime/vendor/update.ts ryu` fetched the nine files at `v2.0 (72e18e8…)`; after
  this change `git status` shows no diff under `packages/runtime/vendor/`.
- `node packages/runtime/vendor/update.ts --check`: `ok ryu @ v2.0 (9 files)` (quickjs-ng and
  fdlibm ok too).
- `pnpm run runtime` exit 0; `pnpm run test:runtime`: `runtime: print corpus matches Node`.
- `pnpm run test:golden`: `golden: 516 fixtures — 516 passed, 0 failed`.
