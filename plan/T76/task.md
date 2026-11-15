---
status: todo
priority: P1
complexity: 4
readiness: 5%
agent:
---

# T76. Concurrent async chains drive a collector count below zero

T75's `promises.ts` bench program found it: two async chains joined by `Promise.all`, each
awaiting another async function in a loop, panic after a few hundred rounds with
`PANIC: collector: a count fell below zero`, while Node prints the sum. It reproduces on every
run, at the commit T75 started from, so it predates T75. One chain alone, or awaiting
`Promise.resolve(...)` instead of an async call, does not panic: the count goes wrong where two
suspended frames resume each other's continuations, which points at the reference counts the
async lowering or the job queue hands to pyrlyn/gc's deferred RC (plan/T66).

```ts
async function step(value: number): Promise<number> {
  await null;
  return value + 1;
}
async function chain(start: number, length: number): Promise<number> {
  let value = start;
  for (let i = 0; i < length; i += 1) value = await step(value);
  return value;
}
async function main(): Promise<void> {
  let total = 0;
  for (let round = 0; round < 1000; round += 1) {
    const r = await Promise.all([chain(round, 100), chain(1, 100)]);
    total += (r[0] ?? 0) + (r[1] ?? 0);
  }
  console.log(total); // Node: 700500
}
void main();
```

Done means the program above prints Node's answer under the default and the ASan runtime, it
lands as a golden fixture, and `packages/tests/bench/programs/promises.ts` goes back to 600
rounds (T75 left it at 200; 300 already panics) with `pnpm run test:golden` green.

Check: `pnpm run test:golden -- --filter=async` and `--filter=bench/promises` pass, the new
fixture included; `pnpm run test:asan` passes.
