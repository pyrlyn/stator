---
status: in progress
priority: P1
complexity: 5
readiness: 100%
agent:
---

# T10.2. OS threads + async bridge

Depends on: T10.1's docs (threads chapters), Task 4.6 machinery, threads-enabled GC.

Steps:

1. Write `docs/THREADS.md` — the seven rules in Design B, plus Boehm build flags.
2. Runtime: thread registry, MPSC completion queue, `jsrt_thread_spawn` / `join` promise.
3. `std/sync` (`Mutex`, `CondVar`, bounded `Channel`).
4. `std/thread.spawn` / `join` / `availableParallelism`.
5. Bridge: `await join` + `runOnMain`; golden where a worker resolves a Promise the main `await`s,
   and an async function offloads CPU work via spawn-join.
6. Update Phase 7 Task 7.2 step 6 text/header when foreign threads may call in **only** via the
   bridge (or keep "undefined" until a 7.2 follow-up — record the choice in plan-notes).
7. Stress: N threads allocating under GC; ASan/UBSan where available.

**Check:** goldens byte-stable where Node has an analogue (Promise side); thread-only fixtures
use Stator's own oracle. Multi-thread GC stress does not crash under ASan.
