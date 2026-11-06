# T10.2. Closing report

**Phase 10 — T10.2 OS threads + async bridge ✅ (2026-10-25)**

Creator-directed std expansion (plan-notes 388). The existing basic std modules gain
`std/thread` (`spawn`, `join`, `runOnMain`, `availableParallelism`), `std/sync` (`Mutex`,
`CondVar`, bounded `Channel<T>`), and the six `std/fs` Promise twins. Public wrappers are
strict TypeScript. POSIX thread/sync primitives and the completion bridge are Zig in the
runtime because they hold GC-visible values. The existing main microtask drain settles joins,
runs posted callbacks and reaps unjoined workers; no second event loop or dependency.

Each worker registers its stack and TLS roots with Boehm. Statement safepoints and return
handoffs keep transient NaN-boxed values alive across collection by another thread. Shape
metadata, spread-order caching and immutable-string append storage are synchronized; std
result/error/I/O state and generated inline caches are thread-local. Native tests exercise
shared captures, mutex/condition contention, FIFO/backpressure/close, rejected joins,
main-thread callbacks, filesystem offload and forced collections with four live workers.

**Check evidence (macOS arm64, pinned Node 26.7.0 / Zig 0.16.0, Boehm):**

`mise exec node zig just -- pnpm run ci` exited **0** on 2026-10-25:

- typecheck and lint/format clean; source-policy check clean;
- `dupes`: **113 clones, 1.8%**, no new clones; baseline shrunk by four fingerprints;
- `test`: **62 test files, 808 tests passed**;
- runtime: **roots ok; print corpus matches Node**;
- subset: **999 fixtures — 968 passed, 31 expected-fail, 0 failed**;
- golden: **483 fixtures — 483 passed, 0 failed** (the two optional Intl fixtures excluded);
- selfhost: compiler counts unchanged (**STA1207 1, STA1213 2, STA1214 1887**), **11 std
  modules built and run + 10 std goldens**, **5 Node modules + 13 Node goldens**;
- builtins gate passed; **docs/NODE.md is current**;
- leak: **10M objects 4384 KB**, **10M FFI strings 4480 KB**, **2M computed-key reads
  4432 KB** peak RSS, each plateaued below the 65536 KB cap;
- ASan/UBSan: runtime roots/print corpus and two static libraries passed; **6 thread/sync/fs
  native tests passed**, including multi-thread forced-GC stress; full golden-asan **483/483**,
  `asan: golden-asan green — recorded 14e6479129b6…`.

The focused `subset --filter subset_std` pass was **29/29**. Thread-only fixtures use explicit
stdout oracles; the ordinary and sanitized golden corpora retain Node's byte-for-byte Promise
checks. Zig primitives run in ReleaseSafe; ASan/UBSan cover C and generated C.

The v0 scope is POSIX, synchronous worker bodies and main-owned Promise operations. Foreign
C-thread callbacks remain undefined (the Task 7.2 follow-up remains required). Filesystem
Promise twins create one OS thread per call; a bounded reusable pool is deferred explicitly
in plan.md and docs/THREADS.md. Shared mutable application objects require synchronization.

The stub `plan.md` kept when the task closed:

~~**T10.2. OS threads + async bridge — [D5].**~~ ✅ **completed 2026-10-25** — evidence above (plan-notes 388).
