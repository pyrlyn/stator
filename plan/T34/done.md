# T34. Done

`Function.prototype.bind` landed. The design is in `docs/VALUE.md` §4.16.

**Runtime**

- A bound function is a plain `JSRTClosure` over a three-slot env: target, `this`, and the bound arguments. One thunk, `bound_call` in `jsrt_builtin_values.c`, drives it. It prepends the bound arguments and calls the target through `jsrt_call_with_this`.
- The card reserved two slots. The bound arguments needed a third.
- `jsrt_get_prop` answers `bind` on any closure, so `call`, `apply` and a second `bind` need no case of their own.
- `jsrt_construct` sees through a bound function (`jsrt_bound_construct`, §10.4.1.2), and so does `jsrt_instanceof_ctor`.
- `name` is `"bound " + name`. `length` is `max(0, length - bound arguments)`.

**Interpreter**

- `fnBind` now calls the runtime's `bind`.
- `isConstructor` and `construct` use `jsrt_is_bound_function`, `jsrt_bound_target` and `jsrt_bound_arguments`.
- Its own bound-function code is gone. A bound function is now the same value whichever tier made it.

**Compiler**

- `isFunctionProtoCall` (`frontend/gate.ts`) admits `call`/`apply`/`bind` on a function value or a JS constructor function. Lowering uses the same predicate.
- `isFunctionValueCallee` accepts the lib's anonymous function type, which is what `bind` returns, so `new` and `instanceof` work on the result.
- `bind` on a class is a named `not-yet(STA1214)`. `new` on a class-typed value builds the descriptor directly and would drop the bound arguments.

**Tests**

- Goldens: `bind_receiver` and `bind_partial_args` in both modes, and `js/bind_new`.
- ts mode cannot spell `new` on a plain function (TS7009), and `bind` on a class is refused. So the ts twin of `bind_new` is the decision test `subset_function_bind_class_ts`, with `subset_function_bind_class_js` beside it.
- `subset_function_bind_ts` and `subset_function_bind_js` moved from `not-yet` to `dynamic`.

**Docs**

- `docs/VALUE.md` §4.16 and the `isFunctionValueCallee` note.
- `docs/SUBSET.md`: the function-properties row and the builtin-values row.
- `docs/INTERPRETER.md` globals.
- The plan.md step 12(e) sentence.

## Check

- Goldens match Node: `pnpm run test:golden` gives `golden: 523 fixtures — 523 passed, 0 failed`. This includes the new bind fixtures and the existing `has_receiver` method-value goldens (`method_value*`, `class_call_arity`).
- `subset_function_bind_*` carry no `expected-fail` and pass as `dynamic`. `subset_function_bind_class_*` pass as `not-yet(STA1214)`. `pnpm run test:subset` gives `subset: 1041 fixtures — 1010 passed, 31 expected-fail, 0 failed`.
- `pnpm run ci` passes, every step from typecheck through `test:asan` (exit 0). Dupes stays at 88 clones. Lint was run as `oxlint --deny-warnings .` plus `oxfmt --check` over tracked files, because a local untracked harness file (`.claude/settings.local.json`) fails the glob.
- Interpreter, after it moved to the runtime's `bind`:
  - `pnpm run interp:test` passes.
  - `pnpm run test262:interp-exec` is unchanged at `14638 / 23726 pass`.
  - The golden suite was re-run (523/523).
