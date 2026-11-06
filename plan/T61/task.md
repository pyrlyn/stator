---
status: todo
priority: P2
complexity: 5
readiness: 0%
agent:
---

# T61. Compiler subset: drive `packages/compiler` to `static`/`dynamic`

Steps:
1. Group the 1887 STA1214 sites by construct; card the top constructs as gate/lowering work or
   rewrite the compiler code into the admitted subset (documented choice per construct).
2. Replace or wrap Node-only dependencies of the compiler (`node:child_process`, `node:fs`,
   `typescript`/tsgo program APIs) behind an interface that `packages/std` / `packages/node`
   can satisfy; list what cannot and why.
3. Run `--update` on the selfhost baseline in every change that shrinks a count.

**Check:** `pnpm run test:selfhost` reports `packages/compiler` as `static` or `dynamic` with
zero codes; the stage-2 guard from Task 6.19 then fires, which T37 resolves.
