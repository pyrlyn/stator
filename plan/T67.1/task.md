---
status: todo
priority: P2
complexity: 5
readiness: 0%
agent:
---

# T67.1. The engine's optimizing JIT tier

T67's baseline JIT turns bytecode into native code one opcode at a time over the frame window.
Beating V8 (the creator's goal for `jit` mode) needs an optimizing tier on top of it: type
feedback from the interpreter and the baseline tier, values in registers, shape-guarded property
access from the inline caches, inlining, and deoptimization back to the interpreter when a guard
fails. It lowers into pyrlyn/jit's IR like the baseline tier and reuses its register allocator.

Done means a function that is hot under the baseline tier is recompiled with these
optimizations, a failed guard resumes it in the interpreter with the same observable result, and
`packages/engine/bench` shows the measured speedup over the baseline tier and the gap to V8.

Check: `node packages/engine/bench/run.ts` with the tier on and off, results recorded.
