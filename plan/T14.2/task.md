---
status: in progress
priority: P2
complexity: 5
readiness: 100%
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

1. `src/bytecode.zig`, `src/compile.zig` and `src/vm.zig`: the stack-machine bytecode, the
   compiler with per-function scope analysis, and the VM over the runtime's helpers and ICs.
2. `src/builtins.zig` and `src/interp.zig`: the global object and the script entry
   (`runScript`, `evalScript`). Unit tests go in `src/interp.zig`.
3. `test262/exec.zig`: one child per test and mode, sharing `test262/common.zig` with the parse
   driver. Record the ratchet in `test262-exec.json`.
4. `packages/tests/bench/record.ts` reads the ratchet into a dashboard column. Add
   `pnpm run test262:interp-exec`.
5. Run QuickJS-NG v0.16.2's `run-test262` over the same slice and measure the binary delta of one
   `eval`. Record both in plan-notes.
6. Update docs: `docs/INTERPRETER.md` (as built, §7, §8, §9), the package README and AGENTS.md.

Verify with `zig build test`, `zig fmt --check`, a full `test262-exec` run and `pnpm run ci`.
