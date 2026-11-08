---
status: in progress
priority: P2
complexity: 3
readiness: 100%
agent: Claude Code / claude-opus-5-5
---

# T34. `Function.prototype.bind` and the two-slot environment

Step 12(e) residue: method values use `has_receiver` (drop the receiver); `bind` *inserts* one
and needs the two-slot `JSRTEnv` `docs/VALUE.md` §4.16 reserved.

Steps:
1. Runtime: `JSRTBound` / env layout with inserted receiver + partial args; `jsrt_call` handles
   the shift (documented beside `has_receiver`).
2. `bind` as a builtin method; `length`/`name` of a bound function per spec (or a named
   not-yet if v0 skips them — decide in `docs/SUBSET.md`).
3. Goldens `bind_receiver`, `bind_partial_args`, `bind_new` (`new` on a bound function) both
   modes; decision tests.

**Check:** goldens match Node; `subset_bind_*` rows leave `expected-fail`; no regression in the
existing `has_receiver` method-value goldens.

## Execution plan

1. Runtime (`jsrt_builtin_values.c`): `bind` builds a `JSRTClosure` over a three-slot env (target,
   `this`, bound arguments; the interpreter's slot order) driven by one thunk `bound_call`.
   `jsrt_get_prop` answers `bind` on any closure, and `jsrt_construct` / `jsrt_instanceof_ctor`
   see through a bound function. `name` and `length` per §20.2.3.2.
2. Compiler: the gate and lowering admit `bind` beside `call`/`apply` (`isFunctionProtoCall`,
   also for a JS constructor function); `new`/`instanceof` accept the lib's anonymous function type
   `bind` returns. `bind` on a class gets a named not-yet: `new` on a class-typed value builds the
   descriptor directly and would drop the bound arguments.
3. Tests: goldens `bind_receiver`, `bind_partial_args` (both modes) and `js/bind_new`. ts mode
   cannot spell `new` on a plain function (TS7009) and class bind is refused, so the ts twin of
   `bind_new` is the decision test `subset_function_bind_class_ts`. `subset_function_bind_*`
   leave `not-yet` for `dynamic`.
4. Docs: `docs/VALUE.md` §4.16, `docs/SUBSET.md` rows, the plan.md step 12(e) sentence.
5. `pnpm run ci`, then `done.md`.
