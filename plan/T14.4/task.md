---
status: todo
priority: P2
complexity: 4
readiness: 60%
agent:
---

# T14.4. Async, generators, and the remaining constructs

Depends on T14.3. Interpreted `async`/`await`, generators and async iteration on the runtime's
`JSRTAsync` and generator machinery (`docs/INTERPRETER.md` §5), plus the `STA12xx` codes §6
assigns to the interpreter: `STA1201`'s residue, `STA1202`, and `STA1214`'s `js`-mode constructs,
through function-level interpretation.

**Check:** the Test262 slice for these features passes at a recorded rate. Each code taken over
flips its decision tests in the same commit, and `explain` no longer lists it for those
constructs.

## Execution plan

1. ✅ **Evaluator** (`packages/interpreter`): suspension ops in `src/bytecode.zig`, frame saving and
   resuming in `src/vm.zig`, generator and async-generator prototypes and the `Promise` methods in
   `src/builtins.zig`, the constructs in `src/compile.zig`, and unit tests in `src/interp.zig`.
2. ✅ **Test262 rate recorded**: `test262-exec.json` went from 8,160 to 14,638 of 23,726, and no
   directory dropped (plan-notes 408).
3. ✅ **Docs**: `docs/INTERPRETER.md` §2, §5, §6, §7 and `packages/interpreter/README.md`.
4. ☐ **Function-level interpretation** in `packages/compiler`: in `js` mode, a function holding a
   `STA1201`/`STA1202`/`STA1214` construct is lowered to an `Interpret` node (§6). Each code taken
   over flips its decision tests in `packages/tests/subset/` and leaves `explain`'s output. This
   touches the TypeScript compiler, which T41 is porting to Zig. Whether it lands there or in the
   port is the creator's call.
