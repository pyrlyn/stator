# Zig compiler core (experimental)

`packages/compiler-zig/` is the start of a rewrite of the Stator compiler core in Zig. It lives
**beside** the TypeScript compiler in `packages/compiler/`, which stays the only compiler that
`stator build` runs. Nothing in the shipping pipeline calls the Zig code yet.

> This direction goes against `AGENTS.md` golden rule 5 ("don't write a parser or type checker —
> use the `typescript` package") and the plan's "the compiler is strict TypeScript". It was
> started on the creator's explicit direction on 2026-10-26; see `plan-notes.md` §391. The
> TypeScript compiler stays authoritative until the switch-over phase below is approved.

## What is ported

| Piece | Zig | Mirrors | Status |
|---|---|---|---|
| Lexer | `src/lexer.zig` | `ts.createScanner` (trivia skipped), as the frontend's parser sees it | done, matches on the whole repo |
| Parser / AST | — | `ts.createSourceFile` | not started |
| Everything after | — | `frontend/`, `lower/`, `passes/`, `codegen/` | not started |

### How the lexer works

`Lexer.next()` returns one `Token { kind, start, end }` at a time, skipping whitespace, comments
and a leading `#!` line. `start`/`end` are UTF-8 byte offsets into the source. `Kind` uses the
`ts.SyntaxKind` names (`ConstKeyword`, `QuestionDotToken`, `TemplateHead`, …) so the two streams
compare one-to-one.

It reproduces the TypeScript scanner's choices, including the surprising ones:

- `>` is always a lone `GreaterThanToken`; the parser re-scans `>=`, `>>`, `>>>`.
- `/` is always `SlashToken` or `SlashEqualsToken`; the parser re-scans regular expressions.
- `?.` followed by a digit is `QuestionToken` (so `a?.5:b` is a conditional).
- A lone `#` is an (erroneous) empty `PrivateIdentifier`.
- Contextual keywords (`type`, `of`, `async`, …) are keyword kinds; the parser decides when they
  are names.

One thing the Zig lexer does itself that the raw TypeScript scanner leaves to its parser: a `}`
that closes a `${ … }` substitution is re-scanned as `TemplateMiddle` / `TemplateTail`. The golden
generator applies the same re-scan, so the expected stream is what the TypeScript parser consumes.

## Build, run, test

Zig is pinned in `mise.toml` (0.16.0, Linux and macOS).

```sh
# Unit tests + golden tests, then check the golden files are not stale:
pnpm run zig-core:test

# Or directly:
cd packages/compiler-zig
zig build test --summary all
zig build                                   # builds zig-out/bin/statorc-zig
./zig-out/bin/statorc-zig tokens some/file.ts
```

`statorc-zig tokens <file>` prints the token stream as `Kind<TAB>start<TAB>end` lines — the
golden-file format.

### Golden files

`src/testdata/samples/*.ts` are lexer inputs; `src/testdata/golden/*.tokens` are their token
streams **generated from the TypeScript scanner** by `tools/gen-golden.ts`. The Zig golden test
(`src/golden_test.zig`) embeds both and requires byte-for-byte equality.

```sh
pnpm run zig-core:golden                    # regenerate after adding or editing a sample
node packages/compiler-zig/tools/gen-golden.ts --check   # fail when one is stale
```

To add a sample: drop `name.ts` into `src/testdata/samples/`, add `"name"` to the `samples` list
in `src/golden_test.zig`, regenerate, run the tests. Samples are lexer input only: they need not
type-check, and lint, format and `tsc` ignore that directory.

### Whole-repo comparison

```sh
cd packages/compiler-zig && zig build && cd ../..
node packages/compiler-zig/tools/compare-corpus.ts $(git ls-files '*.ts')
```

On 2026-10-26 this reported `1157 same, 0 differ` over every tracked `.ts` file.

## Enable / disable

There is nothing to enable yet: no `stator` command uses the Zig core, and no flag switches to it.
The plan below adds an opt-in (`STATOR_CORE=zig` / `--core=zig`) once the parser produces an AST
the TypeScript frontend can be checked against. To disable or remove it, delete
`packages/compiler-zig/` and the `zig-core:*` scripts; nothing else depends on it.

CI does not run it yet. Adding a job is cheap (`zig build test` takes seconds) but means editing
the gate's required-job list in `.github/workflows/ci.yml`; that is a separate change.

## Limitations

- Unicode identifiers are approximated without Unicode tables: code points in symbol,
  punctuation and emoji blocks are `Unknown`, every other non-ASCII code point is an identifier
  character. `\u` escapes in identifiers are not decoded.
- No diagnostics yet: unterminated strings, templates and comments are tokenized the way the
  TypeScript scanner tokenizes them, but no error is reported.
- No JSX scanning and no regular-expression re-scan (both are parser-driven in TypeScript too).
- Template nesting depth is capped at 64 open substitutions.
- Offsets are UTF-8 bytes; the TypeScript side reports UTF-16 units and the golden generator
  converts.

## Phased plan

Sizes are rough, measured against the TypeScript they replace (`packages/compiler/src`, about
48k lines) or, for the TypeScript-package pieces, against what Stator actually needs from them.

| Phase | Scope | Replaces | Rough size | Exit check |
|---|---|---|---|---|
| 1. Lexer | `lexer.zig` | `ts.createScanner` | ~0.5k Zig (done) | golden + whole-repo compare, 0 differ |
| 2. Parser / AST | arena AST for the Stator subset (both modes), error recovery, source positions | `ts.createSourceFile` | 8–12k Zig | AST dump equals a TS-side dump on samples and the repo |
| 3. Binder, type checker, semantics | scopes, symbols, the subset of TS typing the gate and `ts.Type → HType` use, module resolution | `ts.Program`/`TypeChecker`, `frontend/` (~15k TS) | 25–40k Zig — the largest and riskiest phase | `test:subset` verdicts identical |
| 4. HIR, passes, C codegen | HIR model, lowering, monomorphize/DCE/inline, C emitter | `hir/`, `lower/`, `passes/`, `codegen/` (~27k TS) | 20–30k Zig | `test:golden` byte-identical C or output |
| 5. Runtime / toolchain integration | CLI, config, clang/link driver, `libjsrt.a` in one `build.zig` | `cli/`, `support/` (~4.5k TS) | 4–6k Zig | `stator build` works with `--core=zig` |
| 6. Switch-over | `--core=zig` default, TS core opt-in, both in CI | — | small, plus CI time | full `pnpm run ci` green on both cores |
| 7. TS core removal | delete `packages/compiler` and the `typescript` dependency | — | deletion | docs and AGENTS.md updated |

Phases 2–3 decide whether this pays off: TypeScript's checker is very large, and Stator relies on
its inference. A narrower checker for the strict `ts` subset is plausible; `js` mode needs far
less typing.
