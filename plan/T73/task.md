---
status: in progress
priority: P1
complexity: 5
readiness: 75%
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

Steps 9 and 10 are in (`progress.md`, "Push and the young region"): `push` takes its element
in place, and blocks of 512 bytes or less are bumped through a young region whose dead objects
are reclaimed by clearing index words. The kernels stand at 5.45x (cycles), 5.93x (objects)
and 6.16x (numeric) of V8's time, and generated code is now most of each. Next:

11. Values in registers inside a basic block: the lowerer forwards a window slot it has just
    loaded or stored and remembers which values are known doubles, so a chain of arithmetic
    guards and loads each operand once. Locals still reach the window before any helper that
    can throw or collect.
12. A literal's allocation in compiled code: the young region's bump inline, with the helper
    for a full run, a worker thread or the sanitized flavor.
13. `store_env` and `load_env` in place, with the write barrier's dirty-bit test.
14. Numeric after 11: T67.1 step 3, loop-carried values in registers across blocks with
    guards that leave to the baseline code.

Step 11 and the first half of 14 are in (`progress.md`, "The fast chain and carried locals"):
a run of bytecode keeps what it loaded or computed in registers, and a loop that makes no call
carries its numeric locals in float registers from one iteration to the next. 12 and 13 are
still to do. What the numeric kernel's machine code shows next:

15. Integers in registers. A number is always a double, so `(sum + i) % 65521` converts to an
    integer, divides and converts back on the loop's critical path. A local the loop only adds
    to, subtracts from, compares and takes remainders of can be carried as an i64 with a range
    guard, converted only where it is stored.
16. Window stores only where a guard leaves. Every result is written to the frame window at
    once so that a failed guard can leave from anywhere; a flush block per guard, placed with
    the loop, would take those stores out of the loop.
17. A remainder by a constant as a multiplication and a shift.

15 and 17 gave way to something simpler (`progress.md`, "A remainder without a division"): a
remainder whose dividend is below twice its divisor does not divide, which is what the wrap of
a sum or an index is. With the collector's static roots read by section, the numeric kernel is
faster than V8 (16.7 against 22.4 us, ranges apart) and that third of the Check holds; objects
and cycles are at 4.8x and 4.6x. 12, 13 and 16 are still to do, and the profiles add:

18. Object literals on the fast chain. A literal made in a run of bytecode has a shape the
    lowerer can work out when it compiles: each `define` is a store and the next shape, a read
    of a property it has is the value that was stored, with no question to the object, the
    shape table or a cache until an instruction without a form runs.
19. A dynamic object of fewer bytes: 88 for two properties, most of it fields a literal never
    uses (`proto`, `ctor`, `frozen`, a `slots` pointer to the next word), where V8 has 20.

12, 13 and 18 are in (`progress.md`, "Literals on the fast chain, allocated in place"): a
literal is bumped out of the young run by the compiled code, its members are stores, its shape
is stored once, a captured variable is read and written in place, and a local read after its
declaration takes no TDZ check. Cycles went from 4.64x to 1.84x of V8's time and objects from
4.80x to 3.93x; numeric stays ahead. 16 and 19 are still to do, and the cycle kernel's machine
code, about 200 instructions an iteration now, adds:

20. Locals no read can find uninitialized. A `let` or `const` whose every use follows its
    declaration in the same function needs neither the `uninit; store` pair at the scope's
    entry nor the guard the fused local operations take (`liveLocal`). The bytecode compiler
    knows which those are when it resolves the names.
21. Block starts found, not marked. Each literal sets its bit in the young region's index, 16
    instructions for a fact the block's own header states. The collector can index the open
    run when it closes it, by walking the headers from the run's start.
22. Two literals in a row out of one bump: one limit test and one move of the run for both.
23. The read loop of the objects kernel asks every element for its shape, which is what the
    feedback tier of T67.1 is for; a collection there takes 130 us against 23 on cycles.

16 and 21 are in (`progress.md`, "Values out of the window, slots written once, blocks indexed
when asked"): a result is stored in the frame window only before a guard, a call or the run's
end, a literal's slot is written once, and the compiled allocation leaves the collector's index
alone: the collector finds a block by its prefix when something asks about it. Cycles went from
1.84x to 1.30x of V8's time, objects from 3.93x to 3.58x and numeric from 0.75x to 0.61x. 19,
20, 22 and 23 are still to do, and the cycle kernel's listing adds:

24. A guard's stores on the path that fails. A value that waits for the window is still stored
    before every guard it passes. A side block per guard, laid out after the run with the
    other rarely-run blocks, would store it only when the guard fails (what is left of 16).
25. One guard for a value and its copies. An operand copied from a local is checked as if
    nothing were known of it, and the local is checked again afterwards: a copy that remembers
    the slot it came from lets one check serve both, and lets a double be loaded from there.
26. Constants made once a run. The run's address, a block's prefix words, the class, the shape
    and the tags are made again for each literal.

24 is in, with part of 23 (`progress.md`, "Reads on the chain, a guard's stores where it
fails, fewer cycle candidates"): a cached property, an array element and `i < array.length` are
read on the chain, so the objects kernel's read loop is a carried loop; a guard stores nothing
on the path that passes it; and the collector no longer makes a cycle candidate of every object
a dirty holder still holds. Objects went from 3.58x to 2.43x of V8's time and cycles from 1.30x
to 1.22x. 19, 22, 25 and 26 are still to do, and the listings add:

27. What a loop does not change, read once: an array's address, length and elements are read
    again at each element, and the cache's shape and slot at each property.
28. An index that is an integer: a carried counter used as an index is converted from a double
    and checked for exactness at each element.
29. `push` on the chain: the filling loop of the objects kernel calls `get_method` and `push`
    for each element, and a literal that was pushed is forgotten.
30. A dirty object that is dead is not counted first: the array a root held while it was
    filled has all it holds promoted at the next collection and freed in the same one.

Files: `packages/engine/src/{vm,compile,bytecode}.zig`, `packages/engine/src/jit/`,
`packages/runtime/src/{jsrt_alloc,jsrt_gc}.zig`, `packages/runtime/include/jsrt_value.h`. Verify:
`pnpm run interp:test`, `pnpm run engine:test`, `pnpm run test:golden` and `pnpm run test:asan`
when the runtime changes, `pnpm run ci` before a push.

## Check

`pnpm run ci`, `pnpm run interp:test`, and `pnpm run engine:test` pass. The unchanged
three-kernel warmed corpus matches Node byte-for-byte, confirms compiled execution,
and shows lower Stator per-process medians than V8 in every kernel, with nonoverlapping
interquartile ranges over at least five interleaved processes. Record raw measurements,
versions, flags, source hashes, hardware and load. A partial improvement is progress,
not completion or a claim that Stator beats V8 generally.
