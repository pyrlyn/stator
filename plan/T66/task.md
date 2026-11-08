---
status: in progress
priority: P1
complexity: 5
readiness: 85%
agent: Claude Code / claude-opus-5-5
---

# T66. Replace Boehm with pyrlyn/gc

The runtime's only collector today is Boehm (`packages/runtime/src/jsrt_gc.zig`): a conservative
tracing GC that finds NaN-boxed references through a custom mark kind and a push-other-roots hook
over the `JSRT_FRAME` shadow stack. The creator's direction is to replace it entirely with
https://github.com/pyrlyn/gc, used as a Zig module (`kxgc`, `src/kxgc.zig`).

pyrlyn/gc is not a drop-in tracer. It is reference counting with a cycle collector (Perceus RC +
trial deletion; `epoch` adds deferred RC on a background thread). It needs:

- a header word on every collected object (count in bits 0-31, color 32-33, buffered bit 34) and a
  vtable pointer `{rel, trav, relo, freemem, cyclic}` in word 1 (`kxgc.h`, `KXGC_API_VERSION 1`);
- exact counts, which KotlinX gets from its code generator (Perceus retain/release);
- runtime storage that holds references allocated through `rt_gc_mem_*`;
- Zig 0.17.1 (`build.zig.zon` `minimum_zig_version`); Stator pins 0.16.0.

The replacement lands as one change. Until it is complete the runtime is allowed to be broken on
the task branch; `main` only receives the finished replacement.

Stator uses it as deferred reference counting (plan-notes 406): counts cover heap-to-heap
references only, frames, globals and native stacks are roots read at collection, a zero-count
table holds objects no heap reference names, and pyrlyn/gc's trial deletion reclaims cycles.

Done means: Boehm is gone from the tree, build and CI; every collected allocation goes through
pyrlyn/gc; every heap store goes through the barrier and every kind's `trav` matches it; garbage,
cyclic garbage included, is reclaimed; docs describe the new memory model.

Check: `pnpm run ci`, `pnpm run test:asan` and `pnpm run test:leak` (RSS plateaus, no Boehm skip,
plus a cyclic-garbage variant) pass, and `git grep -nE 'JSRT_HAVE_BOEHM|[<"/]gc\.h|bdw-gc|GC_[a-z_]+\('`
over `packages/`, `docs/`, `.github/`, `mise.toml` and `toolchain.md` is empty, but for dated
bench recordings and their analysis under `packages/tests/bench/memory/` and `docs/research/`.

## Execution plan

1. **Design**: plan-notes 406. `docs/VALUE.md` §4 and §4.12 are rewritten in step 9.
2. **Toolchain**: Zig 0.16.0 → 0.17.1 in `mise.toml`, CI, `AGENTS.md`, `docs/TOOLCHAIN.md`,
   `toolchain.md`; port the runtime and std Zig sources.
3. **Dependency**: `packages/runtime/build.zig` + `build.zig.zon` pin an exact pyrlyn/gc commit;
   the build compiles `src/perceus.zig` with Stator's own `host` module (`rt_panic` → `jsrt_panic`,
   `rt_nanos`, `rt_gc_note_pause`, `rt_rel_draining`, `rt_trav_mode`, `rt_relo_owner`) into
   `libjsrt.a`. Row in `toolchain.md`.
4. **Collector core** (`jsrt_gc.zig`): header + vtable allocation, immortal statics, barrier
   (`jsrt_heap_store`, retain/release), ZCT, root scan (frames, pending, handoff, conservative
   native stacks), pinned trial deletion, stop-the-world at safepoints, thread registration.
5. **Every kind**: header, vtable and `trav` for objects, arrays, strings, closures, envs, Map/Set,
   promises and their states, iterators, generators, regexp, date, typed arrays, accessor cells,
   overflow slots, concurrency handles, channels; every store in `packages/runtime/src` and
   `packages/std/zig` through the barrier; buffers via `rt_gc_mem_*`.
6. **Codegen**: `JSRT_ENV_AT` stores become `JSRT_ENV_SET` in `packages/compiler` and the Zig port.
7. **Remove Boehm**: justfile probes and `GC_LIBS`, `link-flags.txt` `-lgc`, CI bdw-gc installs,
   the `test:leak` skip.
8. **Tests**: Zig unit tests for barrier/ZCT/cycles per kind, `jsrt_gc_stress` kept (collect on
   every allocation), golden + ASan over the corpus, leak test plus a cyclic-garbage leak test.
9. **Docs**: `docs/VALUE.md` §4/§4.12, `docs/HOW-IT-WORKS.md`, `docs/architecture/values.d2`
   (+ SVG), `docs/FFI.md` (C code storing values must use the barrier), `README.md`.

Work happens in worktree `stator-t66` (branch `t66-pyrlyn-gc`) and lands as one PR.
