# T14.3. Done

Compiled `js`-mode code now hands `eval`, indirect `eval`, `Function` and `new Function` to the
interpreter.

## What changed

- **Interpreter** (`packages/interpreter/src/`):
  - New C ABI in `packages/runtime/include/jsrt_interp.h`: `jsrt_interp_global` and
    `jsrt_interp_eval_direct`.
  - A direct `eval` runs strict eval code over the caller's binding cells.
  - `Function` is built on `parse.parseFunction`.
  - Eval source becomes WTF-8 through `rt.sourceText`, so U+0000 survives.
  - `print` and `$262` left the global object.
- **Frontend**:
  - `eval` and `Function` are `dynamic` in `js` mode.
  - Every binding a direct `eval` can see is widened to Unknown and kept in an environment cell.
  - STA1206 is narrowed to a direct `eval` in sloppy CommonJS code (plan-notes 406).
- **HIR, passes and emitter**:
  - New nodes `interpret-global` and `direct-eval`, both checked by the verifier.
  - The emitter calls the C ABI.
  - `libjsrt_interp.a` is linked only when the generated C includes `jsrt_interp.h`.
- **Build**:
  - `pnpm run runtime` builds the archive through `packages/interpreter/justfile`.
  - New `interpreter:build` moon task.
  - `test:asan` tracks and builds the interpreter.
- **Test262**:
  - `packages/interpreter/test262/host.ts` is a strict-TS host compiled `--mode=js --node`.
  - `test262/exec.zig` writes each composed test to a file and execs that host.
- **Tests**:
  - Golden fixtures `eval_direct`, `eval_indirect` and `eval_modules`.
  - Decision tests: `subset_eval_call_js` and `subset_new_function_js` flipped to `dynamic`; new
    `subset_eval_sloppy_js.cjs` (STA1206) and `subset_eval_strict_cjs_js.cjs` (`dynamic`).
  - Unit tests: the gate's eval verdicts, and that `libjsrt_interp.a` is on the link line only when
    a module interprets.
- **Docs**: `INTERPRETER.md` (§3 as built, §4, §6, §8, §9), `HIR.md`, `MODES.md`, `SUBSET.md`,
  `DIAGNOSTICS.md`, `AGENTS.md`, `packages/interpreter/README.md`, plan-notes 406.

## How it was checked

- `pnpm run ci` passes locally. It includes `test:golden` (516 fixtures, the `eval_*` ones among
  them, byte-for-byte against Node), `test:subset` (1039 fixtures, 0 failed), `test:selfhost`
  (unchanged at 441 × STA1214) and `test:asan`.
- **Binary sizes:** 18 golden fixtures (10 `js`, 8 `ts`), none of which interprets, were built by
  the base commit's compiler (fc5b912e) and by this change's under the same output name. All 18
  are byte-identical (plan-notes 406).
- **Test262** (`pnpm run test262:interp-exec --update`): 8,160 / 23,726 tests pass (8,105 before);
  crashes fell from 16 to 8. The new baseline is recorded in
  `packages/interpreter/test262-exec.json`.
- `zig build test` in `packages/interpreter` passes.

## Left for later

- STA1206 stays for a direct `eval` in sloppy CommonJS code: its `var`s would have to join a
  compiled scope.
- A direct `eval` does not see imports, function declarations or classes.
- The runtime's error objects do not answer `'constructor' in e`.
- The interpreter's `Promise` has no statics.
- There is no module goal, so Test262's 817 module tests do not run.
