---
status: todo
priority: P2
complexity: 4
readiness: 0%
agent:
---

# T14.1. `packages/interpreter`: the parser front

Depends on T14.0 (`docs/INTERPRETER.md` §1). `packages/interpreter` (Zig) imports stator-ts's
parser (`packages/transpiler/src/parser.zig`) and turns `eval` source (script goal) and the
`new Function` parameter list and body into the tree T14.2 compiles. Early errors are
`SyntaxError`s thrown at run time through the runtime's `jsrt_throw`, the error type Node throws for
the same string. Gaps in stator-ts — TypeScript-only syntax in a JavaScript source is not rejected
today, the script goal, ECMAScript early errors `tsc` does not report — are fixed in stator-ts with
a regression test, coordinated with that package's owners.

**Check:** a Zig test driver runs the Test262 `language/` parse-only tests (negative syntax tests
included) through the interpreter's parse entry at a recorded rate; parse speed and the size of
`libjsrt_interp.a` are recorded in plan-notes.
