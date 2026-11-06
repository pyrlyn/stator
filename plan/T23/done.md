# T23. Closing report

**Builtin-constructor comparison follows the startup snapshot**

Fixed (plan-notes 354). The official win-arm64 Node is cross-compiled without a startup snapshot, so `util.format` sees seven later globals. The test follows `node_use_node_snapshot` and still fails on any other difference.


`unit/to-primitive.test.ts` compared `BUILTIN_CONSTRUCTOR_NAMES` with the host `util.format` set and skipped `win32`/`arm64`, so main's `frontend (windows/arm64)` was green while any branch without the skip failed (PR #61, PR #114). The official win-arm64 Node 26.7.0 is cross-compiled from win-x64, so `node_use_node_snapshot` is false and `inspect.js` records seven later globals. The runtime list stays the snapshot set. The test now branches on that flag and fails unless a no-snapshot build differs by exactly those seven names (plan-notes 354).
