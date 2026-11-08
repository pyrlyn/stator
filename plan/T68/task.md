---
status: in progress
priority: P1
complexity: 4
readiness: 80%
agent: Claude Code / claude-opus-5-5
---

# T68. Make the engine's interpreter faster

The creator's direction (2026-11-08): the interpreter tier is 6 to 17 times slower than QuickJS
(2026-06-04) on small scripts, and must get faster. A profile of `fib`, `loop`, `array` and
`objects` puts most of the time in three places, none of them the work the script asked for:

- the exception check after every instruction, `jsrt_pending()`, an out-of-line call that reads
  a thread-local, so it also pays `_tlv_get_addr` on macOS;
- global names: `jsrt_has_prop` and then `jsrt_get_prop` on the global object, each a chain walk
  with `strcmp`, and `jsrt_get_prop` runs its builtin-member checks before the walk;
- named property reads and writes reach the per-site inline cache only after the same checks.

Done means the interpreter answers the same, faster: fast paths that are exact restatements of
the runtime's own answer for the common case, with the existing path for everything else.

Check: `pnpm run interp:test`, `pnpm run test262:interp-exec` (no regression against
`packages/engine/test262-exec.json`) and the interpreter golden fixtures pass, and the benchmark
below runs faster than before on every script, with the before and after recorded in `done.md`.

## Execution plan

1. **Bench**: seven scripts (fib, loop, objects, array, closure, string, sieve) run through
   `stator-engine run --mode=interp`, best of three, against `qjs` and the pinned Node.
2. **Exception check** (`packages/runtime/src/jsrt_throw.c`, `jsrt_value.h`): export the pending
   flag's address, read once per activation; instructions that cannot throw skip the check.
3. **Numbers** (`packages/engine/src/vm.zig` `binary`, `unary`, jumps): both operands numbers ->
   the f64 operation inline, the runtime helper otherwise.
4. **Globals** (`vm.zig` `loadGlobal`, `storeGlobal`): one inline cache per template key
   (`Template.global_ics`) of (global shape) -> slot, checked before the runtime's walk;
   accessors and misses take the walk.
5. **Arrays** (`vm.zig` `getElem`, `setElem`): an in-range integral index on an array reads or
   writes the element directly.
6. **Properties** (`vm.zig` `getProp`, `setProp`): a dynamic object whose shape matches the
   site's IC reads or writes the slot directly; accessors, frozen objects and `constructor` take
   the existing path.
7. **Verify**: the Check above, plus the JIT tier's tests, since its slow paths call these
   helpers.
