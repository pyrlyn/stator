---
status: todo
priority: P3
complexity: 2
readiness: 100%
agent:
---

# T33. Vendor Ryū for number printing

§12 rung and §15.4's settled "Ryū-exact number printing". `docs/TOOLCHAIN.md` records Ryū as
fetchable but not vendored; the review's move M3 is this card.

Steps:
1. Vendor the Ryū C sources via the `packages/runtime/vendor/update.ts` route; `VENDOR.md`
   pins the commit (same rule as QuickJS-NG).
2. Replace the number printer's shortest-round-trip path with Ryū; keep `-0.0`, non-finites
   and the `console.log` formatting contract (plan-notes 372's print corpus).
3. `pnpm run test:runtime` + golden print corpus byte-for-byte vs Node.

**Check:** `pnpm run test:runtime` and `pnpm run test:golden` pass; `docs/TOOLCHAIN.md`'s Ryū
row flips from "fetchable and unfetched" to "vendored at <commit>"; the vendor script
regenerates from the pin without network drift.
