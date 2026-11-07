---
status: in progress
priority: P2
complexity: 5
readiness: 5%
agent: Claude Code / claude-opus-5-5
---

# T14.2. `packages/interpreter`: the core evaluator

Depends on T14.1. The bytecode compiler and VM of `docs/INTERPRETER.md` §2, in Zig: expressions,
statements, functions, closures, objects, arrays, classes, destructuring, exceptions. Values are
`jsrt_value`; property access goes through the same ICs and helpers compiled dynamic code uses;
interpreter frames come from the Zig memory core (§4).

**Check:** the §8 Test262 slice runs through the interpreter (the Zig driver of T14.1) with its pass
rate tracked in the dashboard (Task 6.3) under its own column; the VM's Zig unit tests pass; §7's
QuickJS-NG comparison is recorded in plan-notes with both numbers.

## Execution plan

Slices land as separate PRs; the task stays open until the Check holds.

1. Build: `packages/interpreter/build.zig` translates `packages/runtime/include/jsrt_value.h` into a
   `jsrt` module and links `packages/runtime/build/libjsrt.a` (plus Boehm when it is installed) into
   the tests and the drivers, so the VM calls the runtime's C ABI directly.
2. Reuse: the NumericLiteral value (`parseNumber`, now in stator-ts's `emit.zig`) moves to
   `packages/jstext`, shared by stator-ts and the interpreter.
3. `src/scope.zig`: one resolver pass per script. Each binding is a frame register, a slot of a
   `JSRTEnv` (when an inner function captures it, the same layout compiled code uses), or a global.
4. `src/bytecode.zig` and `src/compile.zig`: the stator-ts tree to a flat `u8` stream per function,
   with constant, nested-function, IC and handler tables in GC memory.
5. `src/vm.zig`: the dispatch loop. Registers come from `jsrt_gc_alloc` and are published as a
   `JSRTFrame`; a pending exception after any call unwinds to the innermost handler; interpreted
   functions are `JSRTClosure`s whose `fn` is one trampoline.
6. `src/realm.zig`: the global object and the builtins the runtime has only as C functions
   (compiled code reaches them statically), as closures over those functions.
7. `src/capi.zig`: `jsrt_interp_eval_script` compiles and runs a Script and answers its completion
   value, or leaves the exception pending.
8. Zig unit tests per construct: expressions, statements, functions and closures, objects and
   arrays, exceptions; then classes, destructuring, spread, iteration.
9. `test262/run.zig`: Test262's `test/language/` with its harness, one forked child per test (a
   runtime panic must not stop the run), counts ratcheted per directory in `test262-run.json`;
   `pnpm run test262:interp`. Then the Task 6.3 dashboard column and the §7 QuickJS-NG numbers.

Verify: `pnpm run interp:test`, `pnpm run test262:interp`, and stator-ts's own tests after step 2.
