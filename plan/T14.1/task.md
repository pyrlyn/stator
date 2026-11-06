---
status: todo
priority: P2
complexity: 4
readiness: 0%
agent:
---

# T14.1. `packages/interpreter`: the parser front

Depends on T14.0 (§1's choice). Turns source text into the tree T14.2 runs. Early errors are
`SyntaxError`s thrown at run time, the same errors Node throws for the same `eval` string.

**Check:** the Test262 `language/` parse-only tests (negative syntax tests included) pass through
`eval` at a recorded rate; parse speed and the binary-size delta are recorded in plan-notes.
