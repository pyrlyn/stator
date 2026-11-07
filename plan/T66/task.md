---
status: in progress
priority: P1
complexity: 5
readiness: 2%
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
- retain/release emitted by the code generator at every reference copy and drop;
- runtime storage that holds references allocated through `rt_gc_mem_*`;
- Zig 0.17.1 (`build.zig.zon` `minimum_zig_version`); Stator pins 0.16.0.

The replacement lands as one change. Until it is complete the runtime is allowed to be broken on
the task branch; `main` only receives the finished replacement.

Done means: Boehm is gone from the tree, build and CI; every collected allocation goes through
pyrlyn/gc; generated code keeps reference counts exact in both modes; cycles are reclaimed;
docs describe the new memory model.

Check: `pnpm run ci`, `pnpm run test:asan` and `pnpm run test:leak` (RSS plateaus, no Boehm skip,
plus a cyclic-garbage variant) pass, and `git grep -nE 'JSRT_HAVE_BOEHM|gc\.h|bdw-gc|GC_[a-z_]+\('`
over `packages/`, `docs/`, `.github/`, `mise.toml` and `toolchain.md` is empty.

## Execution plan

1. **Design** (`docs/VALUE.md` §4.12 rewrite, `plan-notes.md` entry, `plan.md` §2/§11a edit):
   - header + vtable layout for every heap kind (strings, arrays, objects/shapes, Map/Set, closures
     and envs, promises, typed arrays/ArrayBuffer, errors, regexp, iterators, boxed numbers);
   - how a NaN-boxed `jsrt_value` is retained/released (tag test, then header);
   - which kinds are acyclic (`rt_alloc`) vs possibly cyclic (`rt_alloc_trace`);
   - the collector variant (proposal: `perceus` first, synchronous; `epoch` later);
   - what happens to `JSRT_FRAME`/`JSRT_LOCAL` (kept for exception unwinding only, or removed),
     landing pads releasing locals, worker threads (`jsrt_concurrent.zig`, `jsrt_gc_safepoint`,
     `jsrt_gc_handoff`), `--emit=lib` multi-copy runtimes (`jsrt_gc_shared_kind_p48`).
2. **Toolchain**: Zig 0.16.0 → 0.17.1 in `mise.toml`, CI, `AGENTS.md`, `toolchain.md`,
   `rust.md`-style inventory if any; port runtime/std Zig sources to 0.17.1.
3. **Dependency**: pin an exact pyrlyn/gc commit as a Zig package (`build.zig.zon` hash); the
   runtime justfile builds the `kxgc` module with the chosen collector into `libjsrt.a`; implement
   the host symbols (`rt_panic` → `jsrt_panic`, `rt_nanos`, `rt_gc_note_pause`, `rt_rel_draining`,
   `rt_trav_mode`, `rt_relo_owner`). Row in `toolchain.md`.
4. **Runtime**: rewrite `jsrt_gc.zig` over `kxgc`; give every allocation its header and vtable
   (`jsrt_alloc.zig`, `jsrt_buf.zig`, `jsrt_shape.zig`, `jsrt_string_mem.zig`, `jsrt_typed.zig`, C
   allocation sites); retain/release in every runtime function that stores or drops a reference;
   `rt_gc_mem_*` for value buffers; delete the Boehm mark kind, root hook and thread registration.
5. **std / node backings**: same discipline in `packages/std/zig/*`.
6. **Codegen** (`packages/compiler/src/codegen/`): emit retain on copy into a slot/field/argument
   that outlives the source, release at last use, on reassignment, scope exit and every landing
   pad; typed unboxed values (numbers, booleans) emit nothing. HIR verifier rule for balance.
7. **Remove Boehm**: justfile probes and `GC_LIBS`, CI bdw-gc installs, `test:leak` skip,
   `docs/TOOLCHAIN.md`, `README.md`.
8. **Tests**: runtime unit tests for RC and cycles (Zig), golden + ASan over the whole corpus,
   leak test plus a cycle-leak test, `jsrt_gc_stress`/`jsrt_gc_watch` reworked or replaced.
9. **Docs**: `docs/VALUE.md`, `docs/HOW-IT-WORKS.md`, `docs/architecture/values.d2` (+ SVG),
   `docs/FFI.md` (ownership across the C boundary), this task's `done.md`.

Work happens in its own worktree off `origin/main`, on one branch, merged as one PR.
