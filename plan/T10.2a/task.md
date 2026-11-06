---
status: in progress
priority: P1
complexity: 3
readiness: 100%
agent:
---

# T10.2a. Reuse OS workers for asynchronous filesystem operations

Creator-directed follow-up to T10.2.
Reuse the existing thread completion queue, GC registration and per-job std cleanup. Extend
its private spawn ABI with pooled submission, keep public `std/thread.spawn` dedicated, and
route the six `std/fs` Promise twins through a shared internal TypeScript helper. Lazily start
at most four workers; queue excess jobs without blocking main. Reuse workers across Promise
continuations, then stop and join idle workers when the main drain is quiescent. No new
public API, dependencies, pool configuration, cancellation or foreign-thread support.

**Check:** native tests prove one worker serves sequential filesystem jobs, bursts stay within
four workers while completing every job, failures do not poison subsequent jobs, and GC/shutdown
stay correct. Run those tests under ASan/UBSan and `pnpm run ci`; update docs in the same change.
