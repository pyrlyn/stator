---
status: todo
priority: P2
complexity: 3
readiness: 0%
agent:
---

# T37. Stage0/1/2 bootstrap with a fixed-point check

Steps:
1. `scripts/bootstrap/stages.ts`: stage0 = Node-hosted `statorc` (or `statorc0` from T36);
   stage1 = stage0 builds the compiler; stage2 = stage1 builds the compiler.
2. Fixed point: stage1 and stage2 emit **byte-identical C** for the compiler and for every
   golden fixture; stage2's C for hello-world equals the Node-hosted compiler's C (Task 6.19's
   stage-2 check).
3. `stator self` (like `v self`): rebuilds the running compiler from source via stage1->stage2
   and atomically replaces the binary only when the fixed point holds.

**Check:** `pnpm run bootstrap:stages` exits 0 and prints matching SHA-256 for stage1/stage2 C;
a deliberately non-deterministic emitter change makes it exit non-zero.
