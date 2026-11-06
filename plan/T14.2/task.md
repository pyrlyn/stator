---
status: todo
priority: P2
complexity: 5
readiness: 0%
agent:
---

# T14.2. `packages/interpreter`: the core evaluator

Depends on T14.1. The bytecode compiler and VM of `docs/INTERPRETER.md` §2, in Zig: expressions,
statements, functions, closures, objects, arrays, classes, destructuring, exceptions. Values are
`jsrt_value`; property access goes through the same ICs and helpers compiled dynamic code uses;
interpreter frames come from the Zig memory core (§4).

**Check:** the §8 Test262 slice runs through the interpreter (the Zig driver of T14.1) with its pass
rate tracked in the dashboard (Task 6.3) under its own column; the VM's Zig unit tests pass; §7's
QuickJS-NG comparison is recorded in plan-notes with both numbers.
