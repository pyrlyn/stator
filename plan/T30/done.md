# T30. Done

The clone baseline went from **88 fingerprints to 0**. `.jscpd-baseline.json` stays in place,
empty (`{"version": 1, "fingerprints": {}}`), which the Check allows. The config and the
`dupes`/`dupes:baseline` scripts are unchanged, so a new clone still fails `pnpm run dupes`.
AGENTS.md golden rule 10 now says the baseline stays empty. `plan.md` Task 6.16 is struck and
records this as its final tranche.

## What changed

Runtime C (`packages/runtime/src/`):
- `jsrt_utf.h` (new) holds the UTF-16 helpers that several files had copied:
  - `jsrt_utf16_code_point`
  - `jsrt_utf16_scalar`
  - `jsrt_utf8_encode`
  - `jsrt_utf16_to_ascii`
  - `jsrt_utf16_to_cstr`
- `jsrt_string.c` drives both UTF-8 decoders with one count-then-store loop (`string_from_utf8_with`).
- `jsrt_string_ops.c` adds `unit_string_at` for charAt/at and `affix_match` for startsWith/endsWith.
- `jsrt_index_util.h` adds `jsrt_element_index`.
- `jsrt_array_ops.c` adds the walk helpers (`walk_appending`, `some_or_every`, `reduce_walk`) and an X-macro method table.
- `jsrt_date.c` adds `date_text` plus its writers, `number_or` and `components_date`.
- `jsrt_ops.c` adds `loose_kind`/`converts_to_number`, and `jsrt_numeric.c` adds `ordered_or_equal`.
- Smaller changes:
  - `jsrt_check.c`: `checked`.
  - `jsrt_print.c`: one `LabelEntry` table for counts and timers.
  - `jsrt_shape.c`: `statics_entry`.
  - `jsrt_math.c`: `JSRT_MATH_UNARY` for the one-line members.
  - Also edited: `jsrt_map.c`, `jsrt_regexp.c`, `jsrt_unicode.c`, `jsrt_value.c`.
- `include/jsrt_value.h`: one banner comment only, no ABI change.

Compiler (`packages/compiler/src/`):
- `frontend/syntax-kinds.ts` (new) adds `syntaxKindSet` and `syntaxKindMap`. Kind tables are spelled by member name, so tables listing different kinds no longer read as copies of each other. The kind sets in `gate.ts`, `generics.ts`, `types.ts` and `lower/captures.ts`, and the operator maps in `lower/`, use them.
- `gate.ts`:
  - Kinds accepted outright move out of the switch into `ACCEPTED_NODE_KINDS`.
  - The binary operators become `ACCEPTED_BINARY_OPERATORS` and `COERCING_ARITHMETIC`.
  - `CALLBACK_ARRAY_OPS` is now a Set.
  - `COLLECTION_OPS` moved to `hir/nodes.ts` and is shared with the verifier.
- `frontend/types.ts` adds `singleClassOf` and `memberStaticName`, and one Symbol.iterator reader.
- `frontend/program.ts` adds `innermostAt`.
- `hir/verify.ts` adds `verifyOperands`, a string-list `MATH_ARITY`, and `COLLECTION_ARITY` derived from `COLLECTION_OPS`.
- `lower/index.ts`:
  - New helpers: `nodeSpan` (136 call sites), `lowerGuarded`, `substituteMembers`, `buildFromRight` and `builtinFieldRead`.
  - The `familyCall`/`staticCall` predicates, and each call's prologue bound once.
  - `LITERAL_KEYWORDS`.

Docs and examples:
- `docs/research/node-mode/scan.ts` adds `tally`/`tallyRows`. Its output is identical to the committed `scan.md`.
- `examples/ffi/stat/stat_shim.c` adds `stat_field`.

## Kept with `jscpd:ignore` markers

There were two existing markers. Two more were added, each with its reason written in the file:
- `lower/index.ts` `lowerStatement`: the for / for-of / for-in / switch arms. This is a dispatch table: each arm lowers a different node type with the same context, so a lookup table cannot hold them.
- `lower/index.ts` body lowering: the hoist-then-lower pair, which is the null-after-diagnostic error model every lowering uses. Under identifier renaming it matches the call lowering's callee-then-arguments pair.

## Commits

- `T30: share runtime C helpers behind the recorded clones`
- `T30: share compiler helpers behind the recorded clones`
- `T30: share helpers in the node-mode scan and the stat FFI example`
- `T30: empty the clone baseline; close the task`

## Check

- `pnpm run dupes`: `0 clones · 0.0% duplication`, exit 0, against the empty baseline.
- `pnpm run test`: `Tests 828 passed (828)`.
- `pnpm run test:subset`: `subset: 1041 fixtures — 1010 passed, 31 expected-fail, 0 failed`.
- `pnpm run test:golden`: `golden: 525 fixtures — 525 passed, 0 failed`.
- `pnpm run test:runtime`: `runtime: print corpus matches Node`.
- `pnpm run test:asan`: `golden: 525 fixtures — 525 passed, 0 failed`, `asan: golden-asan green`.
- `pnpm run test:selfhost`: `22 targets match the baseline`. The ratchet shrank (STA1214 441 → 436) and was recorded.
- `pnpm run ci`, on the branch rebased onto `origin/main`: every step from `check-node` through `test:asan` exits 0, including `builtins: 258/324`, `leak: … plateau` four times and `asan: golden-asan green`.
- Lint ran as `oxlint --deny-warnings .` plus `oxfmt --check` over tracked files. `pnpm run lint`'s glob also reaches the untracked, harness-owned `.claude/settings.local.json`, as in T28.
