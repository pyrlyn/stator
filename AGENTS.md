# AGENTS.md — Stator

Instructions for AI agents (and humans) working in this repository. Read this file fully, then read `plan.md` — the roadmap and spec. When this file and `plan.md` disagree, `plan.md` wins; report the conflict in `plan-notes.md`.

`plan.md` holds only what is **still open**. Completed tasks live in `done.md`; read it when you need to know how something was built, not to decide what to build next.

## What this project is

**Stator** is an ahead-of-time compiler that turns TypeScript/JavaScript into native binaries, in two modes:

- **`ts` mode (default):** strict, statically compiled TypeScript. `.ts` files only. `any` is a compile error; dynamic escape hatches (`eval`, `new Function`, `Proxy`, prototype mutation, `var`, `arguments`) are compile errors — `eval` permanently, by design. Typed code compiles to unboxed machine values; that's where the speed comes from.
- **`js` mode:** JavaScript, or JS + TS mixed, in one module graph. Untyped code is never rejected — it compiles via a dynamic representation (NaN-boxed tagged values, shape tables, inline caches). `eval` is "not yet" until the Phase-8 interpreter tier.

One pipeline; mode is a policy layer (file acceptance + diagnostic table + typing of unresolved code). Nothing below the frontend gate knows the mode existed.

Pipeline: `typescript` API (parse + type-check, in-process) → mode gate → typed HIR → passes → C emitter → clang → link `libjsrt.a` (C11 runtime + Zig memory core, plan-notes 238 / T9.1) → native binary. How that looks: D2 in `docs/architecture/` (gallery `docs/ARCHITECTURE.md`). `plan.md` §2 is the authority.

## Bootstrap awareness

If `src/` does not exist yet, the project is pre-Phase-1: the only files may be `plan.md`, `AGENTS.md`, and possibly `NICHE.md`/`plan-notes.md`. In that state your task is Phase 0 or Phase 1 of `plan.md`, and the Commands section below describes the *target* state, not the current one. Phase 0 requires an explicit human approval — never self-approve it.

## Golden rules

1. **Roadmap discipline.** Work `plan.md` top-down. A task is done only when its **Check** passes, and "done" is claimed only with the Check's command output cited. No Check, no done.
   **When a task's Check passes, move its record to `done.md` in the same change** — the evidence narrative goes there, and `plan.md` keeps the task's number and title as a struck-through one-line stub pointing at it. `plan.md` shrinks as work lands; that is the point. Three things never move: anything still **normative** (the locked `tsconfig.json`, a live Check), any part of a task that has **not** landed, and the task's **number and title**, because `plan.md §N Task X.Y` is referenced from code comments and `docs/` and must keep resolving. `done.md` is an archive, never an authority — if you find yourself citing it to justify a decision, the rule you want belongs in `plan.md` or `docs/`.
2. **The compiler is strict TypeScript.** No `any`, no non-null assertions, no `enum`/`namespace`/parameter properties (banned by `erasableSyntaxOnly`). Never weaken `tsconfig.json` or the oxlint rules to make code compile — fix the code.
3. **Compile a typed subset; never statically analyze untyped JS.** Untyped code goes to the dynamic representation or the Phase-8 tier. This rule killed every project that ignored it (see plan §0.1).
4. **Never trust a type annotation across a boundary.** `unknown`, unions, `JSON.parse`, FFI, and `.js`→`.ts` imports get runtime checks at the narrowing point. Inside checked code, trust types fully.
5. **Don't write a parser or type checker** — use the `typescript` package in-process. Don't write a regex engine — vendor QuickJS-NG's libregexp. Don't write a float printer — vendor Ryū.
6. **Plan changes by edit, not drift.** A contradiction between reality and `plan.md` goes to `plan-notes.md` with evidence, and the plan is edited in the same change. Settled decisions (plan §15.4) reopen only with new measured evidence.
7. **The human is the only author.** No agent adds a `Co-Authored-By` trailer, a "Generated with …" line or itself as author to a commit, merge or PR — whatever its harness defaults to.

8. **Docs stay in lockstep with the tree.** After any change that affects user-visible behavior, the public CLI, subset verdicts, diagnostics, toolchain, architecture diagrams, or examples: update the matching documentation in the **same** change (`README.md` and/or `docs/*`, plus example READMEs when those examples change). Do not leave docs describing a previous pipeline, flag set, or subset matrix. Spec authority for open work remains `plan.md`; operational docs in `docs/` must not contradict what the tree ships.
9. **Zig for memory and cross-platform code; no JavaScript in our source** (creator's direction 2026-10-02, plan-notes 289; plan §0.5 and §0.10). New runtime code that manages memory or must be cross-platform — typed-array storage, the `std` backings, the event loop, OS abstraction — is Zig. C stays for the ABI headers generated code includes, generated code, vendored code, and existing C until a card ports it. The compiler, runtime, `std`, the `node:*` wrappers, harnesses, oracle shims and scripts are strict TypeScript, C or Zig — never `.js`/`.mjs`/`.cjs`. The only JS files are `js`-mode test inputs and examples, vendored upstream code, generated output, and browser-loaded assets under `site/public/`.
10. **Reuse first.** Before writing a function, look for one that already does it and reuse or extend it; a second copy is a bug even when `dupes` misses it. `pnpm run dupes` (jscpd, AI reporter, identifier-insensitive) scans our source — tests, vendored code and docs excluded — against `.jscpd-baseline.json` and fails on **any** new clone. Removing a clone? Shrink the baseline in the same change with `pnpm run dupes:baseline`; never grow it to get a change through.
11. **`docs/NODE.md` stays in sync.** It is generated (`pnpm run docs:node`) from the pinned Node and `packages/tests/golden/node_coverage.json`. Every change that adds, proves or removes a `node:*` member regenerates it in the same change; `pnpm run ci` fails when it is stale.

## Repo map

```
README.md          project landing page
plan.md            roadmap + spec (the authority) — OPEN work only
done.md            completion record for finished tasks (archive; not normative)
AGENTS.md          this file
plan-notes.md      evidence log for plan contradictions/decisions
NICHE.md           Phase-0 niche justification (human-gated)
docs/              README.md (index) HOW-IT-WORKS.md ARCHITECTURE.md (D2 gallery) architecture/*.d2 MODES.md SUBSET.md DIAGNOSTICS.md VALUE.md NUMERIC.md HIR.md TOOLCHAIN.md FFI.md STD.md NODE.md (generated) research/
.moon/             moon workspace: workspace.yml, toolchain.yml (orchestrator; plan-notes 204)
packages/compiler/ the compiler package "statorc" — holds src/ + the locked tsconfig.json
  src/cli/         argument parsing, build/explain drivers
  src/frontend/    ts.Program loading, mode policy gate, ts.Type → HType (only place ts.Type may appear)
  src/hir/         typed HIR definitions, HType model, verifier
  src/lower/       TS AST → HIR lowering
  src/passes/      monomorphize, boundary-insert, const-fold, DCE, inline
  src/codegen/     C emitter (#line source maps, JSRT_FRAME rooting discipline)
  src/support/     diagnostics engine, shared utilities
packages/runtime/  C11 + Zig memory core (plan-notes 238 / T9.1; NOT an npm package) → packages/runtime/build/libjsrt.a (justfile)
  include/jsrt_value.h   mirrors docs/VALUE.md — the codegen↔runtime contract
  vendor/          QuickJS-NG libregexp (+cutils/libunicode); patched only via plan-notes.md
packages/std/      "@stator/std" — the std/* modules (docs/STD.md): src/<module>.ts surface (strict TS,
                   Stator's own subset) + zig/<module>.zig backings → packages/std/build/libjsrt_std.a (justfile)
packages/node/     "@stator/node" — the --node platform (docs/MODES.md §6): src/<id>.ts is node:<id>, strict TS
                   over std/*; resolved by the compiler only under --node, compiled into the importer
packages/vite-stator/ "vite-stator" — the default bundler adapter (`--bundler=vite`) and the stator() Vite
                   plugin (docs/BUNDLER.md); calls statorc/api only, never compiler internals
packages/tests/    the test package "@stator/tests" — every harness + a tsconfig extending compiler's
  unit/            vitest unit tests (*.test.ts; config: packages/tests/vitest.config.ts)
  subset/          decision tests (feature × mode matrix)
  golden/ts|js     machine-checked vs Node, byte-for-byte
  differential/    fuzzer corpus       bench/  baselines + results
  test262/         runner + pin (corpus fetched, not vendored)
  node-suite/      Node's own test/parallel slice: pin, expectations, strict-TS common/, vitest driver (corpus fetched)
  leak/            GC hygiene: a 10M-object loop whose RSS must plateau
  impact/          test impact: map recorder, selector driver (`test:impact`), mutation check
  selfhost/        self-compilation ratchet: targets.json, baseline.json (plan §9 Task 6.19)
examples/vite/     `vite build` → native binary through vite-stator (a workspace package)
```

Paths in prose below are written relative to their package (`src/frontend/` = `packages/compiler/src/frontend/`, `runtime/vendor/` = `packages/runtime/vendor/`, `tests/subset/` = `packages/tests/subset/`).

## Architecture diagrams (for agents)

How the compiler works is drawn in **D2**, not Mermaid and not a new ASCII sketch.

| View | Source (edit this) | Render (GitHub) |
|---|---|---|
| Compile pipeline | `docs/architecture/pipeline.d2` | `docs/architecture/pipeline.svg` |
| `stator build` sequence | `docs/architecture/build.d2` | `docs/architecture/build.svg` |
| Package imports | `docs/architecture/packages.d2` | `docs/architecture/packages.svg` |
| Value boxing | `docs/architecture/values.d2` | `docs/architecture/values.svg` |

Gallery + captions: `docs/ARCHITECTURE.md`. Shared theme: `docs/architecture/theme.d2`.

- **Authority is `plan.md` §2.** If a diagram and §2 disagree, fix the diagram — or file `plan-notes.md` and edit §2 if the plan is wrong.
- Read `pipeline.d2` first when you need the pipeline. Do not invent a fifth view.
- When the pipeline changes (new pass, new package, `ts.Type` leaking, mode leaking below the gate), update the matching `.d2` in the same change and regenerate the SVG with the `d2` commands in `docs/ARCHITECTURE.md`.
- `d2` is a docs tool (`brew install d2`), not part of `pnpm run ci`.

## Commands

Dev runs TS directly on the pinned Node (≥24, see `.node-version`) — no build step needed.
`mise install` provides that Node, pnpm, just, moon, LLVM clang 21.1.8, Zig 0.16.0 (Unix; required for the runtime once T9.1 lands), and jactionlint, hk and shellcheck for the workflow lint.
If bare `node --version` disagrees with `.node-version` (on some hosts PATH puts mise's
`node/lts` ahead of the shims, so bare `node` answers 24), prefix commands with
`mise exec node --` — `pnpm run ci` refuses to start otherwise (plan.md Task 6.2a).

```
mise install                    # Node, pnpm, just, moon, LLVM clang, Zig 0.16.0 (Unix)
pnpm install --frozen-lockfile  # install (exact-pinned deps)
pnpm --dir site install --frozen-lockfile  # site/ has its own lockfile; `lint` type-checks site/ too
pnpm run typecheck              # tsc --noEmit (strict; must be clean)
pnpm run lint                   # oxlint --deny-warnings + oxfmt --check — lint + format (must be clean)
pnpm run format                 # oxlint --fix + oxfmt (applies safe fixes + formatting)
pnpm run dupes                  # jscpd over our source (no tests/vendor/docs): fails on any clone not in .jscpd-baseline.json
pnpm run dupes:baseline         # rewrite .jscpd-baseline.json — only to SHRINK it after removing clones
pnpm run schema:config          # regenerate packages/compiler/schema/stator.config.schema.json after a config key changes
pnpm run docs:node              # regenerate docs/NODE.md (Node API coverage, % per module and member)
pnpm run test:node-coverage     # fail when docs/NODE.md is stale (part of `ci`)
pnpm run test                   # unit tests (vitest) — the default; use this for the gate
pnpm run test:impact            # only the tests (every harness) your diff reaches, from the impact map; falls back to everything, saying why — iteration, never the gate
pnpm run test:impact:record     # full instrumented run at a clean HEAD → .cache/impact/impact-map.json (never committed)
pnpm run test:coverage          # same under c8 + packages/compiler/src coverage table; writes coverage/lcov.info — ONLY when the coverage table is the question (it costs ~4x wall time)
pnpm run test:subset            # decision tests → verdict matrix
pnpm run test:golden            # compile + run vs Node, byte-for-byte
pnpm run test:selfhost          # Stator explains (and builds) its own packages; per-code counts may only shrink
pnpm run test:runtime           # the runtime's own print corpus vs Node, byte-for-byte
pnpm run test:asan              # golden fixtures with runtime + generated C under ASan/UBSan
pnpm run test:leak              # 10M-object loop; RSS must plateau (skips without Boehm)
pnpm run test262                # Test262 slice against packages/tests/test262/pin.json (not part of `ci`)
pnpm run test:node-suite        # Node's own tests (packages/tests/node-suite/pin.json) through vitest, ratcheted (not part of `ci`)
pnpm run differential           # fuzzer vs Node (failures land in packages/tests/differential/failures/)
pnpm run bench:record           # refresh packages/tests/bench/baseline.json (valid for this machine only)
pnpm run runtime                # build libjsrt.a (clang, -Wall -Wextra -Werror; wraps the just recipe), then libjsrt_std.a
just -f packages/runtime/justfile -d packages/runtime runtime       # the recipe directly
just -f packages/runtime/justfile -d packages/runtime runtime-asan  # ASan/UBSan runtime build
just -f packages/runtime/justfile -d packages/runtime runtime-intl  # ICU feature build (off by default)
just -f packages/std/justfile -d packages/std std                  # the std/* backings → libjsrt_std.a (Zig, ReleaseSafe)
pnpm run test:intl              # the intl_* golden fixtures against that build (not part of `ci`)
pnpm run ci                     # all of the above, in order — run before claiming any task done
moon run tests:ci               # same gate through moon (dependency graph + caching); wraps the above
mise x -- jactionlint           # lint workflows, composite actions, dependabot.yml (CI: `static analysis`; not part of `ci`)
mise x -- jactionlint --baseline-write  # refresh .github/jactionlint-baseline.json after fixing findings
mise x -- hk install --mise     # install the pre-push hook (hk.pkl runs jactionlint) once per clone
node packages/compiler/src/cli/main.ts build file.ts -o app [--mode=ts|js] [--node] [--emit=c] [--keep-c]
node packages/compiler/src/cli/main.ts explain file.ts --json   # per-construct verdicts (decision tests use this)
node packages/compiler/src/cli/main.ts build                   # entry, -o, mode, … from ./stator.config.json (docs/CONFIG.md); flags override it
```

The monorepo (plan-notes 204): `packages/{compiler,runtime,std,tests}` under a pnpm workspace,
orchestrated by moon. `pnpm run ci` stays the serial gate; `moon run tests:ci` runs the same
commands as a cached dependency graph. moon tasks call the underlying tools directly (not `pnpm`),
because mise's `pnpm` is unusable from a raw child process on this machine — plan-notes 204.

## Implementation standards — TypeScript (`src/`)

- `tsconfig.json` is locked (full flag list in plan §4 Task 1.0): `strict` + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, NodeNext modules.
- oxlint (`.oxlintrc.json`, type-aware through `oxlint-tsgolint`) enforces: no `any`, no non-null assertions, exhaustive switches, type-only imports. Model discriminated unions and switch exhaustively — this is a compiler; unhandled cases are bugs.
- Runtime dependency budget: **`typescript` only**, plus the owner-directed CLI/observability set recorded in `plan-notes.md` 187 (ink, react, dotenv, `@opentelemetry/*` behind `STATOR_OTEL`; execa is dev-only), and `typebox` + `jsonc-parser` for `stator.config.json`, confined to `src/cli/config.ts` (plan-notes 303). This set may not leak below `src/cli/` (except `src/support/telemetry.ts`, which is the pipeline's only OTel seam). New dependencies (even dev) need a `plan-notes.md` entry saying what a few lines couldn't do.
- User-facing failures are diagnostics (stable `STA` code + span + mode), never thrown stack traces. A thrown exception reaching the CLI is a compiler bug (`STA4xxx`).
- **Every new CLI flag lands with its config key** in `src/cli/config.ts` and a regenerated schema (`pnpm run schema:config`) in the same change, plus its row in `docs/CONFIG.md`. Only `--config`, `--no-config`, `--help` and `--version` have no key (plan.md §9 Task 6.18).
- `ts.Type` never leaks past `src/frontend/` — everything downstream speaks HType.
- Comments state invariants the code can't (`// pops must mirror frame pushes, incl. landing pads`), not narration.

## Implementation standards — C runtime (`runtime/`)

- C11, `clang -Wall -Wextra -Werror`; ASan/UBSan job in CI is mandatory and blocking. The full flag set is the rule for code we WRITE (`runtime/src/`); `runtime/vendor/` compiles with `-Wall` alone, because upstream source is not ours to fix and a warning flag is not a correctness flag (plan-notes 101). ASan/UBSan cover both.
- T9.1 (plan-notes 238) landed the memory core in Zig 0.16.0 (`runtime/src/*.zig`): the GC glue, the growable buffers, the shape table and the allocation helpers. It `@cImport`s the C headers rather than mirroring any layout, exports only the C ABI declared in `jsrt.h`, `jsrt_value.h` and `src/jsrt_mem.h`, and passes `zig fmt --check`. Zig has no warnings, only errors; the ASan flavor builds it `ReleaseSafe`, so its safety checks stand in for the sanitizers it cannot take. Do not invent a second memory core. Since plan-notes 289, new memory-managing or cross-platform runtime code is Zig too (golden rule 9); existing C is ported only by a card.
- All value access goes through `jsrt_value.h` accessors; no hand-rolled bit twiddling outside it.
- GC rooting discipline: every generated function opens `JSRT_FRAME(n)`; locals via `JSRT_LOCAL`; frames pop on **every** exit path including landing pads. The runtime may assume it; codegen must guarantee it.
- Generated C is never hand-edited — fix the emitter and re-emit.

## Testing rules

- **Decision tests** (`tests/subset/`): first-line directives `// @mode: ts|js`, `// @verdict: static|dynamic|error|not-yet`, `// @code: STAxxxx` (required for error/not-yet). Pre-implementation tests carry `// @expected-fail: true`; the runner reports (never hides) that count; removing the marker happens in the same commit that makes the test pass.
- **Golden tests** (`tests/golden/`): stdout must match the pinned Node **byte-for-byte** — including number formatting (Ryū shortest-round-trip). Never loosen a comparison to make a test pass; a mismatch is a semantics bug. A fixture named `node_*` builds with `--node`, so its `node:*` imports resolve to `packages/node`.
- Every new language construct lands with: decision test(s) for both modes + at least one golden test + HIR-verifier-clean build. Non-trivial runtime code lands with a unit test.
- Differential ground truth is the pinned Node LTS in `.node-version` — that Node, and only that Node.
- **Unit-test default is plain `test`.** Run `pnpm run test`, not `pnpm run test:coverage`, unless the coverage table itself is what you need — coverage is measured in CI (the stage-1 `frontend (linux/x64)` job, id `frontend-coverage`, owns the lcov artifact; Windows and macOS jobs never collect coverage), not on every local run.
- **`test:impact` selects; `pnpm run ci` stays the local gate.** The selection comes from a per-test coverage map (`pnpm run test:impact:record`, plan.md §9 Task 6.17): the functions each test executed, the data files it read, and the runtime sources its binaries linked. It prints what it chose and why, and falls back to the full run when the map cannot be trusted (none, another Node or platform, a commit that is not an ancestor, a dirty recording). On a pull request, CI does that download-and-select step itself (the map comes from the newest `main` recording); `main` and the nightly record and upload it. Plain `test` and `pnpm run ci` stay the local gate.

## Diagnostics conventions

`STA0xxx` CLI/config/toolchain · `STA10xx`/`STA11xx` mode & subset violations (**never** class — by design, e.g. `STA1001` any-in-ts-mode, `STA1101` eval-in-ts-mode) · `STA12xx` **not-yet** class (message names the delivering phase) · `STA2xxx` lowering/boundary — mostly compile-time, but `STA2001` (boundary check failed) is the one diagnostic the *emitted program* raises at runtime · `STA3xxx` module graph (`STA3001` import cycle) · `STA4xxx` internal error (always a bug). Full table: `docs/DIAGNOSTICS.md`, which is the sole allocator — never allocate a code anywhere else, and never reuse, renumber, or revive a retired one. Tests reference codes, not message text.

## Workflow

1. Find the first unmet Check in `plan.md` (phases in order, tasks in order). That's the current task, unless the human directs otherwise. A struck-through stub is done — its evidence is in `done.md`; don't redo it.
2. Before coding, read the docs the task references (`docs/VALUE.md`, `docs/NUMERIC.md`, …). If the task leaves you guessing, that's a plan bug — fix `plan.md` via `plan-notes.md`, don't invent conventions in code.
3. Implement with tests (see Testing rules). Run `pnpm run ci` locally. If the change affects behavior, CLI, subset, diagnostics, toolchain, architecture, or examples, update the matching docs in this same change (golden rule 8).
4. Move the finished task's record from `plan.md` to `done.md` (golden rule 1), leaving the stub behind.
5. Report: what changed, the Check command + its output, any `plan-notes.md` entries added.
6. Commit style: short imperative subject naming the task (`phase2: emit JSRT_FRAME prologue (task 2.4)`); one task per commit where practical; no agent attribution (golden rule 7).

## Don'ts

- Don't self-approve the Phase-0 gate; don't skip a phase's entry Check.
- Don't add dependencies, weaken compiler options, or disable lint rules to get unstuck.
- Don't hand-edit generated C or `runtime/vendor/` (vendored patches only via `plan-notes.md`).
- Don't quote competitor benchmark numbers as measurements — measure locally, record version/flags/hardware.
- Don't "fix" a golden-test mismatch by changing the expected output without proving Node produces it.
- Don't let mode logic leak below the frontend gate — if a pass or the emitter needs to know the mode, the design is wrong (plan §0.8).
- Don't duplicate code or logic — find the existing helper and reuse it, or extract one shared helper at the responsible layer. `pnpm run dupes` fails on any clone not already in `.jscpd-baseline.json` (golden rule 10); a clone you write today is a CI failure today.
- Don't draw the compiler pipeline in Mermaid or a new ASCII sketch — D2 in `docs/architecture/` is the diagram language.
- Don't ship a behavior/CLI/subset/diagnostics/architecture change without updating the matching docs in the same change (golden rule 8).

## Parent rules and config files

If a directory above this repository contains an `AGENTS.md` or `CLAUDE.md`, follow it too. If it conflicts with this file, ask the creator.

**Config files.** A config file this project owns has a schema generated from its types (Rust: `schemars`), committed and checked by a drift test, and one module owns all config loading, validation and editing. A config file another program owns (an agent host's or an editor's) gets no schema from us: check only our own entry in it and leave the rest byte-for-byte, comments included.
