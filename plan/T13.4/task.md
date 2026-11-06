---
status: todo
priority: P3
complexity: 5
readiness: 0%
agent:
---

# T13.4. `packages/renderer-clay`: the default renderer

Depends on T13.3. New workspace package:

- `clay.h` vendored under `vendor/` at a pinned tag (v0.14 unless T13.0 finds a reason to pin a
  later commit), fetched by the runtime's vendor update script (`pnpm run vendor:update`), patched
  only via plan-notes. It compiles with `-Wall` alone, as all vendored C (plan-notes 101).
- Zig glue (§0.5): the arena (`Clay_MinMemorySize` → `Clay_CreateArenaWithCapacityAndMemory` →
  `Clay_Initialize`), the text-measure callback, and the drawing backend from T13.0 §6. Exports a
  C ABI only, as `runtime/src/*.zig` does.
- A strict-TS adapter that implements `Renderer` over the Zig glue through Phase 7 FFI.
- An example under `examples/webapi/` with its README; `docs/TOOLCHAIN.md` gains the backend.

**Check:** the T13.3 contract test passes; T13.0's layout oracle agrees within the documented
tolerance on every fixture; `examples/webapi` builds a native binary on macOS, Linux and Windows
that renders and reacts to a click; ASan/UBSan clean.
