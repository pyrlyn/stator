---
status: in progress
priority: P2
complexity: 4
readiness: 100%
agent: Claude Code / claude-opus-5-5
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

## Execution plan

1. `packages/interpreter/` (Zig 0.17, `build.zig` + `build.zig.zon`, stator-ts by path as
   `packages/compiler-zig` does). `src/parse.zig`: `parseScript`, `parseFunction(kind, params,
   body)` (ECMA-262 CreateDynamicFunction's source text) answering the tree or the first
   `SyntaxError` (message and offset) from stator-ts's diagnostics.
2. `src/capi.zig`: the C ABI the runtime will call in T14.3, raising `SyntaxError` through
   `jsrt_throw_error(&jsrt_class_syntax_error, …)`; `zig build lib` → `libjsrt_interp.a`.
3. `test262/parse.zig`: a Zig driver over `<corpus>/test/language` — front matter (`negative`
   phase `parse`, `flags` module / onlyStrict / noStrict / raw) decides the goal and the expected
   outcome; it prints pass / fail per directory and ratchets against
   `packages/interpreter/test262-parse.json`. `pnpm run test262:interp-parse` runs it (not part of
   `ci`, like `test262`).
4. Measure parse speed and `libjsrt_interp.a` size → plan-notes; record the driver's rate.
5. stator-ts gaps found by the driver: fixed in `packages/transpiler` or handed to its owners
   (asked of the creator).
6. Docs: `docs/INTERPRETER.md` §9, `AGENTS.md` repo map, `docs/README.md`, `toolchain.md`,
   the package `README.md`.

Verify: `zig build test` in `packages/interpreter`, the driver's rate, `pnpm run ci` stages.
