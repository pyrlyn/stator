---
status: in progress
priority: P1
complexity: 3
readiness: 100%
agent:
---

# T11.3a. `Uint8Array` across the extern boundary

Depends on T11.1 (the storage) and replaces T11.3's byte channel before T11.3 steps 2 and 3
merge.

- `Uint8Array` becomes a parameter row in the extern table (docs/FFI.md §2), and a return row
  too if that is cheap; decide and document it.
- The emitter passes pointer + length from the T11.1 Zig-owned storage; the backing copies at
  most once.
- GC rule: the buffer stays rooted and does not move for the call. Check the T11.1 design and
  say how it is guaranteed.
- `packages/std` drops `internal/bytes.ts` and the push/at channel; `io.writeBytes`/`read` move
  to the new row.
- Docs: FFI.md, STD.md §6, SUBSET.md, DIAGNOSTICS.md if STA1115's wording changes.

**Check:** decision tests in both modes; goldens that pass a `Uint8Array` to an extern and get
bytes back, byte-for-byte vs Node (for std/io); an ASan run; a unit or bench measurement showing
1 MB crosses in one call, not 1M, with numbers recorded in plan-notes.
