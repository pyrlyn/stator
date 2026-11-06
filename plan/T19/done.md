# T19. Closing report

**Small runtime fixes: RegExp NULL-capture and `replace_impl` double scan**

`jsrt_regexp_test` passed `capture_buffer`'s NULL (bytecode whose header claims no captures and no registers) straight into `exec_at`, and `lre_exec` writes `capture[i]` before it reads the subject. `jsrt_regexp_search` already treated that NULL as a miss. The refusal now lives in `exec_at`, so `test`, `search` and `scan` share it; `search` no longer keeps a second copy of the check.

`replace_impl` called `index_of_from` in the counting loop's condition and again for the same hit, then the length pass and the emit pass each searched from the start again (the three sites at the old `jsrt_string_ops.c` lines 507–508, 523 and 537). One scan records the positions — plain `uint32_t`s, malloc'd, freed before the result is boxed — and both later passes read that list. An empty pattern still advances by one and still measures the match as zero units.

Model: Cursor / grok 4.7 · Status: done 2026-10-15 · Priority: P3 · Complexity: 1 · Files: `packages/runtime/src/jsrt_regexp.c`, `packages/runtime/src/jsrt_string_ops.c`

Check: `just -f packages/runtime/justfile -d packages/runtime runtime-test` — `roots ok` then `runtime: print corpus matches Node` (plain malloc, no LTO). `node packages/tests/golden/run.ts --filter string_builtins` — `golden: 2 fixtures — 2 passed, 0 failed`. The same runner with `--filter primitive_methods` and `--filter regexp_strings` — 2 passed each. Observed 2026-10-15.
