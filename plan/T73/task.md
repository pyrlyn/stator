---
status: in progress
priority: P1
complexity: 5
readiness: 20%
agent: Claude Code / claude-fable-5-2
---

# T73. Make warmed Stator JIT faster than V8 on the established corpus

Creator-directed: compare Stator JIT with V8 JIT and make Stator faster. Keep T69's
numeric, objects and cycles kernels, excluding startup and checking every answer.
T71 reduced numeric time by 11.06%; the remaining gaps are 8.54x, 52.44x and 32.04x.
Do not close this card merely for another incremental improvement. The creator explicitly
selected memory and object work on 2026-11-08. On 2026-11-16 the creator reassigned this
card and T67.1 to one agent, so the optimizing tier is no longer out of its scope.

## Execution plan

1. Reuse T69/T71's warmed harness, baseline binaries and raw samples. Check V8 optimized
   compilation separately, without adding instrumentation to throughput measurements.
2. Profile numeric, object and cycle kernels independently. T67.1 is owned elsewhere;
   do not take its optimizing-tier work. Investigate disjoint runtime allocation and
   storage costs first, using the existing collector and object representations.
3. Implement only measured, semantics-preserving improvements, with focused regression
   tests and the existing engine/collector checks. Retain every losing benchmark row.
4. Compare baseline, changed JIT and pinned V8 in interleaved processes. Update docs and
   keep this task open until the complete performance Check is met.

### From 2026-11-16 (pyrlyn/gc `ef3b440`, pyrlyn/jit `e90d570`)

Profiles of the three kernels (macOS `sample`, the ReleaseFast `stator-steady` host) put the
time here. Objects: `retained.push` reads its method through `jsrt_array_method`, which compares
names and allocates an environment and a bound closure on every call (40% of the samples);
`define` takes the shape table's lock for the transition and grows the slots from nothing
(28%); `jsrt_dynobj_new` (9%). Cycles: `define` (64%) and `jsrt_dynobj_new` (19%). Numeric: all
of it is generated code, the loop's values going through the frame window on every instruction.

Steps, each measured with `packages/tests/engine/steady.ts` before the next:

5. `get_method` in compiled code reads the activation's bound-method cache the interpreter
   already keeps (`vm.getMethod`), inline on a hit.
6. Object literals (T67.1 step 2): a transition cache for `define`, `new_object` carrying the
   literal's property count so the slots are allocated once, and the cached `define` inline.
7. The allocation path itself: what `jsrt_dynobj_new` and the slot buffer still cost after 6,
   and whether one allocation can hold both without changing the retired-buffer contract.
8. Numeric: T67.1 step 3, values of a hot loop in registers with guards that leave to the
   baseline code.

Steps 5 and 6 are in, with an array's `length` and indexed reads and writes in compiled code
(the profile after 6 put the object kernel's second loop in those helpers). Step 7 is half
done: a literal's object and slots are one allocation. What the profiles show next
(`progress.md`, "Literals and arrays"):

9. `a.push(v)` in compiled code: the call helper, the runtime's method dispatch and
   `array_store` are a third of the object kernel.
10. The allocator: two thirds of the cycle kernel is allocating, zeroing, indexing and freeing
    one block per object. Dead young objects are finalized and freed one at a time; reclaiming
    them in bulk needs young objects in pages of their own, which is a change to the memory
    core and its conservative block index, not to the engine.

Files: `packages/engine/src/{vm,compile,bytecode}.zig`, `packages/engine/src/jit/`,
`packages/runtime/src/jsrt_alloc.zig`, `packages/runtime/include/jsrt_value.h`. Verify:
`pnpm run interp:test`, `pnpm run engine:test`, `pnpm run test:golden` and `pnpm run test:asan`
when the runtime changes, `pnpm run ci` before a push.

## Check

`pnpm run ci`, `pnpm run interp:test`, and `pnpm run engine:test` pass. The unchanged
three-kernel warmed corpus matches Node byte-for-byte, confirms compiled execution,
and shows lower Stator per-process medians than V8 in every kernel, with nonoverlapping
interquartile ranges over at least five interleaved processes. Record raw measurements,
versions, flags, source hashes, hardware and load. A partial improvement is progress,
not completion or a claim that Stator beats V8 generally.
