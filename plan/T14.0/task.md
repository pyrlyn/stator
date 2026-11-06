---
status: in progress
priority: P2
complexity: 4
readiness: 100%
agent: Claude Code / claude-opus-5-5
---

# T14.0. Design: the interpreter

Docs first (§15.6): `docs/INTERPRETER.md`, settled with a measured spike. The spike `eval`s one
expression and one function body from a compiled `js` program through a minimal evaluator, and
prints what Node prints. Questions it must answer:

1. **The parser, and §0.3.** §0.3 forbids the *compiler* from writing a parser. The interpreter
   needs one at run time for `eval` strings. Options:
   - (a) The `typescript` package's own scanner and parser, compiled into the binary by Stator in
     `js` mode, tree-shaken to `createSourceFile`. This keeps §0.3 literally, but depends on T11.4
     (`tsc` compiles) and Phase 12 (tree-shaking).
   - (b) An existing ECMAScript parser written in TypeScript, vendored, if one builds under the
     locked `tsconfig` and is maintained.
   - (c) A parser written here, which needs a plan-notes entry, and §0.3 is edited if this is the
     choice.

   Measure binary size and parse speed for each option that builds.
2. **Execution model.** Tree-walking over the AST, or compiling to bytecode first. QuickJS uses
   bytecode. Measure both on the spike before choosing.
3. **Direct `eval` and scopes.** A direct `eval` sees its caller's locals. Which compiled functions
   must keep their scope as an environment record (only those that contain a direct `eval`), what
   indirect `eval` sees (global only), and how `var` declarations inside `eval` behave in sloppy
   mode and in strict mode.
4. **Boundary with compiled code.** Calls in both directions, exceptions crossing it (landing pads,
   `JSRT_FRAME` pops — AGENTS.md rooting rules), GC roots held by interpreter frames, and
   `this`/`new.target`/`arguments` inside interpreted functions.
5. **Async and generators.** Interpreted `async`/`await`, generators and `for await` drive the
   same promise/microtask machinery as compiled code (Task 4.6), with no second event loop.
6. **Which `not-yet` codes it takes over.** `STA1206` first. List the other `STA12xx` codes the
   interpreter can serve (e.g. `with`, sloppy-mode-only forms) and which stay with Phase 8 or stay
   `not-yet`. Any new diagnostic codes are allocated in `docs/DIAGNOSTICS.md`.
7. **QuickJS-NG after this.** Keep Phase 8 as an alternative behind `--interpreter=stator|quickjs`,
   or retire it. The answer comes from Test262 numbers and binary size, not taste.
8. **Oracle.** Test262 (Task 6.1) run through `eval`, so every test executes in the interpreter,
   plus differential fuzzing against the pinned Node (Task 6.2).

**Check:** `docs/INTERPRETER.md` answers 1–8 with the spike's numbers; plan-notes records the
choices; T14.1–T14.4 are edited to match; `docs/README.md` lists the new doc.

## Execution plan

1. Spike: a minimal evaluator (tree walker and bytecode VM over one parser) compiled by Stator and
   called from a `js`-mode program; parse a 640 KB source with it and with stator-ts's parser.
2. Measure parser options (a)–(d): build or `explain` each, record size and parse speed.
3. Put the creator's choices (parser, evaluator language) to the creator.
4. Write `docs/INTERPRETER.md` §0–§9, plan-notes 394, rewrite §11f and plan/T14.1–T14.4, list the
   doc in `docs/README.md`.
5. Verify: `pnpm run ci` steps, no new failure against the `origin/main` baseline.
