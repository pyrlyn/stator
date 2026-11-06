# T14.0. Closing report

**Phase 14 — T14.0 Design: the interpreter ✅ (2026-11-06)**

`docs/INTERPRETER.md` answers questions 1–8 with the spike's numbers (§0). The creator chose
stator-ts's parser (option (d)) and Zig, in the runtime, for the evaluator; the spike chose
bytecode over tree walking (fib(25): 0.42 s against 1.23 s). plan-notes 396 records the choices and
the measurements. plan.md §11f, the Phase 8 cross-reference and plan/T14.1–T14.4 are edited to
match, and `docs/README.md` lists the new doc. `docs/SUBSET.md` and `AGENTS.md` now name Phase 14
for `eval`/`new Function`.

The spike found two compiler bugs (plan-notes 396); the `.length` one is fixed in
pyrlyn/stator#248, and direct method calls lost `this` until plan-notes 395 fixed them.

**Check evidence:** docs and plan only; no code changed. See the PR for the `pnpm run ci` steps
against the `origin/main` baseline.
