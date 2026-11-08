---
status: in progress
priority: P2
complexity: 5
readiness: 35%
agent: Claude Code / claude-opus-5-5
---

# T67.1. The engine's optimizing JIT tier

T67's baseline JIT turns bytecode into native code one opcode at a time over the frame window.
Beating V8 (the creator's goal for `jit` mode) needs an optimizing tier on top of it: type
feedback from the interpreter and the baseline tier, values in registers, shape-guarded property
access from the inline caches, inlining, and deoptimization back to the interpreter when a guard
fails. It lowers into pyrlyn/jit's IR like the baseline tier and reuses its register allocator.

Done means a function that is hot under the baseline tier is recompiled with these
optimizations, a failed guard resumes it in the interpreter with the same observable result, and
`packages/tests/engine/bench.ts` shows the measured speedup over the baseline tier and the gap to
V8. V8 is the only reference the benchmark compares against (the creator's direction).

## Execution plan

Profiles (macOS `sample`, fib(38) and objects-churn ×3) put the baseline tier's time in:
uncached global loads (`jsrt_has_prop` + `jsrt_get_prop` with strcmp, ~25% of fib), per-call
helpers for `this`, `home` and the constructor return, the five-layer call path
(`helpers.call` → `vm.call` → `callInterpreted` → `run` → `exec`), thread-local reads on every
pending-exception check, and for objects the shape transition and slot allocation per literal
property plus `jsrt_get_prop` reaching its inline cache only after its string compares.

Steps, each measured against V8 with `pnpm run engine:bench` before the next:

1. Baseline-tier fast paths in `src/jit/`: inline shape-guarded loads from the site's inline
   cache (`get_prop`, and `load_global` through the template's per-key cache), dead prologue specials
   dropped, `ret_ctor` inline for a plain call, a direct call into compiled code that skips the
   interpreter's call layers.
2. Object literals: a cached shape transition per `define` site and slots sized for the literal.
3. The optimizing tier: type feedback, unboxed doubles in registers, guards that deoptimize into
   the interpreter, inlining of small callees.

Verify: `pnpm run interp:test`, `pnpm run engine:test`, `pnpm run engine:bench`,
`pnpm run test:golden` when the runtime changes.

Check: `pnpm run engine:bench` with the tier on and off, results recorded in `docs/ENGINE.md` §4.
