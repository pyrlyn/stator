# T14.2. Done

PR: https://github.com/pyrlyn/stator/pull/270

## What landed

In `packages/interpreter/`:

- `src/bytecode.zig`, `src/compile.zig` and `src/vm.zig` are the bytecode compiler and VM.
  - A stack machine over one thread-local value stack.
  - Each call publishes its window as a `JSRTFrame`.
  - Scope analysis is per function.
  - Named property access goes through a `JSRTIC` per site.
- `src/builtins.zig` is the global object.
- `src/interp.zig` holds `runScript` and `evalScript`.
- `test262/exec.zig` is the execution driver.
  - It runs each test in a child process, once per mode its flags ask for, with a 10 s timeout.
  - It ratchets per-directory pass counts in `test262-exec.json`.
  - It shares metadata, modes, the corpus walk and the ratchet with the parse driver through
    `test262/common.zig`.

Elsewhere:

- `packages/tests/bench/record.ts` sums that file into a new dashboard column, "Test262 language/
  (interpreter)". `packages/tests/bench/README.md` shows it.
- `pnpm run test262:interp-exec` runs the driver. It is not part of `ci`.

Docs: `docs/INTERPRETER.md` gained an "as built" part in §2 and updates to §4, §7, §8 and §9. The
package README and the AGENTS.md repo map and commands were updated too.

## How it was checked

- **Test262 `language/`** at the pin `771005236e88`: 8,105 of 23,726 tests pass (34.16%). The run
  had 0 timeouts and 8 crashes, all runtime panics (`STA2004`, `STA2005`). 8,817 tests stop at a
  construct the compiler refuses; generators and async functions are most of them. The 817 module
  tests wait for T14.3.
- **Ratchet:** `zig build test262-exec -Doptimize=ReleaseSafe -- --update` recorded it.
- **Unit tests:** `zig build test` passes, and `zig fmt --check` is clean.
- **QuickJS-NG v0.16.2**, on the same slice:
  - It passes 23,134 tests. The interpreter passes 35.0% of that, below §7's 95%, so QuickJS-NG
    is not retired.
  - The stripped binary delta of one `eval` is +394,832 B for the interpreter (`ReleaseSmall`)
    and +979,888 B for QuickJS-NG.
  - Both numbers and the method are in plan-notes 403.
- **Plan contradiction:** interpreter frames come from a page-allocated stack, not the Zig memory
  core. plan-notes 403 records it, and docs/INTERPRETER.md §2 and §4 say so.
- **`pnpm run ci`:** passes. One run failed only `ts/node_timers.ts` under ASan: a `setImmediate`
  ran before a same-tick timer's output, a timing race in the sanitized build. Nothing here links
  into golden binaries, and a rerun of `pnpm run test:asan` passed 512 of 512.
- **Duplication:** `pnpm run dupes` finds no new clones; the baseline did not grow.
