---
status: todo
priority: P2
complexity: 3
readiness: 0%
agent:
---

# T36. Bootstrap C snapshot (`statorc.c`)

Steps:
1. `stator build --emit-c-only` writes the compiler's C plus the runtime sources it needs into
   one reproducible tree (`bootstrap/` or a separate `pyrlyn/stator-c` repo, like `vlang/vc`;
   decide and document).
2. No absolute paths, timestamps or host-specific defines in the output; one header stamps the
   source commit.
3. Script `scripts/bootstrap/regen-snapshot.ts` regenerates it; CI fails when the committed
   snapshot is stale.

**Check:** on a clean macOS arm64 and Linux x64 box, `cc -O2 -o statorc0 <snapshot>/*.c -lm`
(plus the documented GC link) produces a binary that compiles `examples/hello` to a running
executable, with no Node installed.
