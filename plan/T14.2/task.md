---
status: todo
priority: P2
complexity: 5
readiness: 0%
agent:
---

# T14.2. `packages/interpreter`: the core evaluator

Depends on T14.1. Expressions, statements, functions, closures, objects, arrays, classes,
destructuring, exceptions. Values come from the runtime, and property access goes through the same
ICs and helpers compiled dynamic code uses.

**Check:** the T14.0 §8 Test262 slice runs through `eval` with its pass rate tracked in the
dashboard (Task 6.3) under its own column; golden fixtures for `eval` match Node byte-for-byte.
