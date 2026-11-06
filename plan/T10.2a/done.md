# T10.2a. Closing report

**Phase 10 — T10.2a Reusable filesystem workers ✅ (2026-10-25)**

The six filesystem Promise twins share a lazy pool capped at four POSIX workers. Excess
jobs queue without blocking main, and workers survive across Promise continuations. The
existing completion queue, active-job GC roots and std cleanup serve both dedicated and
pooled work. Idle workers release transient roots; quiescence stops and joins the pool, and a
later drain may restart it. Public `std/thread.spawn` remains a dedicated-thread operation.
Native primitives are Zig; the internal typed submission helper and filesystem API are
TypeScript. No dependency, public configuration or new public API was added.

**Check evidence:** `mise exec node zig just -- pnpm run ci` exited **0** on 2026-10-25,
macOS arm64, pinned Node 26.7.0 / Zig 0.16.0 with Boehm:

- typecheck, lint/format and source-policy checks passed; duplication **113 clones / 1.8%**,
  no new clones or baseline changes;
- unit: **62 files, 809 tests passed**; focused std suite **21/21**;
- subset: **999 fixtures — 968 passed, 31 expected-fail, 0 failed**; focused std slice **29/29**;
- golden: **483/483**, plain and ASan/UBSan; optional Intl fixtures excluded;
- selfhost: **17 targets match**; **11 std modules + 10 goldens**, **5 Node modules + 13
  goldens**; compiler diagnostic counts unchanged (**1 STA1207, 2 STA1213, 1887 STA1214**);
- builtin coverage passed; **docs/NODE.md is current**;
- leak: **10M objects 4384 KB**, **10M FFI strings 4448 KB**, **2M computed-key reads
  4448 KB** peak RSS, all plateaued below the 65536 KB cap;
- ASan/UBSan runtime and static-library gates passed; **7/7 thread/sync/fs tests passed**,
  `asan: golden-asan green — recorded 6c481a23ebed…`.

The pool fixture measures successful OS thread creation: **32 sequential writes use one
worker**, 96 queued reads complete within the four-worker limit, a subsequent wave reuses
those workers, and a failed read does not poison the next job. It forces 100 collections
with queued/live results, drains and restarts the pool, and checks the final reaction of an
unawaited filesystem chain before process exit. The same fixture passed under ASan/UBSan.

Removing the intermediate `Thread<T>` wrapper makes the six filesystem subset fixtures and
fs selfhost target static; their expectations and docs were updated (plan-notes 389). Pending
queue length remains unbounded; callers control the number of queued operations.

The stub `plan.md` kept when the task closed:

~~**T10.2a. Reuse OS workers for asynchronous filesystem operations — [D3].**~~ ✅ **completed 2026-10-25** — evidence above (plan-notes 389).
