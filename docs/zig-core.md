# Zig compiler core (experimental)

`packages/compiler-zig/` is the start of a rewrite of the Stator compiler core in Zig. It lives
**beside** the TypeScript compiler in `packages/compiler/`, which stays the only compiler that
`stator build` runs. Nothing in the shipping pipeline calls the Zig code yet.

> This direction goes against `AGENTS.md` golden rule 5 ("don't write a parser or type checker —
> use the `typescript` package") and the plan's "the compiler is strict TypeScript". It was
> started on the creator's explicit direction on 2026-10-26; see `plan-notes.md` §391–392. The
> rule is not edited. The TypeScript compiler stays authoritative until the switch-over phase
> below is approved.

## Architecture

The Zig core does **not** hand-write a lexer, parser or type checker:

| Concern | Provided by | How Zig reaches it |
|---|---|---|
| Lexer, parser, AST, syntax errors | [Oxc](https://oxc.rs) `oxc_parser` | `oxc-bridge` static library, C ABI |
| Scopes, symbols, references (binder) | Oxc `oxc_semantic` | same |
| Type checking | TypeScript 7 (the Go port, `tsgo`) API server | separate process, IPC (phase 3, not built yet) |
| Lowering, passes, C codegen, driver | Zig (to port) | — |

### Why Oxc and not SWC

- Oxc's parser is roughly 2–3x faster than SWC's and uses less memory (arena AST).
- `oxc_semantic` builds scopes, symbols and resolved references — most of what the binder
  phase needs. SWC has no equivalent beyond hygiene marks.
- Stator already depends on Oxc tooling (oxlint, oxfmt).
- SWC's strengths are transforms and minification, which Stator does not need.
- Neither has a TypeScript type checker; that is handled separately (phase 3).

### How the bridge works

`packages/compiler-zig/oxc-bridge/` is a standalone Rust crate (its own `[workspace]`, pinned to
Oxc 0.155, `Cargo.lock` committed) built as a `staticlib`. `stator_oxc_parse(path, source)`:

1. parses with `oxc_parser` (`path` only selects the dialect: `.ts`, `.tsx`, `.js`, `.d.ts`, …);
2. runs `oxc_semantic` with the node store and the extra syntax checks enabled;
3. copies the result into flat arrays and drops the Oxc arena:
   - nodes in pre-order, `{ kind, parent, start, end }` (`kind` indexes a per-handle name table
     with Oxc `AstKind` names such as `Function`, `TSInterfaceDeclaration`; `parent` is a node
     index, `0xFFFFFFFF` for `Program`; offsets are UTF-8 bytes);
   - error diagnostics `{ start, end, message }` (parser + semantic);
   - scope, symbol and reference counts.

`src/oxc.zig` declares the `extern` functions and wraps them in an `Ast` handle (`nodes()`,
`kindName()`, `diag()`, `stats()`, `deinit()`). `build.zig` runs `cargo build --release` on the
crate, then links `libstator_oxc_bridge.a` into the tests and the CLI.

The flat node list is enough for counting, dumping and position mapping. Lowering will need node
payloads (operators, names, literal values, type annotations); the plan is to extend the bridge
with a typed, versioned encoding rather than walk Oxc's Rust structs from Zig.

## Build, run, test

Requires Zig 0.16.0 (pinned in `mise.toml`, Linux and macOS) and a Rust toolchain with Cargo
(Rust ≥ 1.97, Oxc's MSRV). The first build compiles Oxc (about a minute).

```sh
pnpm run zig-core:test      # zig build test: bridge unit tests (parse, scopes, errors, UTF-8)
pnpm run zig-core:corpus    # parse every tracked .ts/.tsx/.mts/.cts file; exit 1 on any error

cd packages/compiler-zig
zig build                                     # zig-out/bin/statorc-zig
./zig-out/bin/statorc-zig parse some/file.ts  # stats, diagnostics, indented AST dump
./zig-out/bin/statorc-zig check a.ts b.ts     # "FAIL path:offset: message" lines + summary
```

On 2026-10-26 the corpus check over 1158 tracked files reported `1153 ok, 5 failed` (426k nodes,
about 2.7 s). The 5 are deliberate negative subset tests whose source is invalid TypeScript that
Oxc's semantic checks reject (`with`, duplicate `__proto__`, two constructor implementations,
required-after-optional parameter, assigning `arguments`). They are expected.

## Enable / disable

Nothing uses the Zig core yet and no flag switches to it. The plan adds an opt-in
(`STATOR_CORE=zig` / `--core=zig`) at phase 5. To remove it, delete `packages/compiler-zig/`,
the `zig-core:*` scripts and the ignore entries in `.gitignore`, `.oxlintrc.json` and
`.oxfmtrc.json`.

CI does not run it: a job means editing the gate's required-job list in
`.github/workflows/ci.yml` and adding Rust to the runners; that is a separate change.

## Limitations

- Oxc's AST is ESTree-shaped with TS extensions, not `ts.SyntaxKind`. Node kinds and counts do
  not line up one-to-one with the TypeScript parser, so there is no automatic AST equality check
  against `ts.createSourceFile`; mapping to TS nodes is by source span (phase 3).
- Only kinds, parents and spans cross the C ABI today; no node payloads, tokens, comments or
  symbol/scope tables.
- Oxc's semantic checks are stricter than `tsc` parsing for a few constructs (see the 5 expected
  corpus failures); Stator's own `STA*` diagnostics are not produced.
- Offsets are UTF-8 bytes; TypeScript reports UTF-16 units. Position mapping must convert.
- Each parse copies the AST out of the arena (simple and safe; costs one copy).
- Cargo is invoked on every `zig build` (it no-ops when up to date); no cross-compilation story
  yet for the Rust part; Windows not supported (as with the runtime).

## Phased plan

Sizes are rough, against the TypeScript they replace (`packages/compiler/src`, ~48k lines).

| Phase | Scope | Uses | Rough size | Exit check |
|---|---|---|---|---|
| 1. Front end | Oxc parser + semantic via `oxc-bridge`, CLI, corpus check | Oxc | ~0.6k Rust+Zig (done) | corpus parses, only expected failures |
| 2. AST payload bridge | typed node encoding (operators, names, literals, type annotations), comments, symbol/scope tables across the C ABI | Oxc | 2–4k Rust+Zig | Zig-side AST dump round-trips the repo |
| 3. Type checking | Zig client for the TypeScript 7 API server, pinned TS 7 version, Oxc-node ↔ TS-node mapping by source span, `ts.Type → HType` queries, `frontend/` gate rules on Oxc AST | `tsgo --api` | 6–10k Zig (was 25–40k for a ported checker) | `test:subset` verdicts identical |
| 4. HIR, passes, C codegen | HIR model, lowering from Oxc AST, monomorphize/DCE/inline, C emitter | — | 20–30k Zig | `test:golden` byte-identical C or output |
| 5. Toolchain integration | CLI, config, clang/link driver, `libjsrt.a` in one `build.zig`, `--core=zig` | — | 4–6k Zig | `stator build --core=zig` works |
| 6. Switch-over | `--core=zig` default, TS core opt-in, both in CI | — | small + CI time | `pnpm run ci` green on both |
| 7. TS core removal | delete `packages/compiler` (the `typescript` dependency becomes TS 7) | — | deletion | docs and AGENTS.md updated |

Total Zig/Rust to write drops from ~58–88k to ~33–50k lines; the riskiest piece (a type checker)
is replaced by integration work.

### Phase 3: type checking through the TypeScript 7 API

TypeScript 7 (the Go port, formerly `typescript-go`) ships an API server: `tsgo --api` (to become
`tsc --api`), see `cmd/tsgo/api.go` and microsoft/typescript-go PRs #711 and #3430. It speaks over
stdio or a socket, either synchronous MessagePack or async JSON-RPC (`--async`), and exposes
projects, source files, symbols and types.

Plan:

- Run it as a **separate process**; a thin Zig client (framing, MessagePack, request/response
  structs) lives in `src/tsapi/`. A stub is enough until phase 2 lands.
- Pin an exact TS 7 build (`@typescript/native-preview` exact version in `package.json`, same
  pattern as the pinned `typescript`), because the API is marked not-ready and changes.
- Protocol-compat tests: start the pinned server, run a fixed set of requests over fixtures,
  compare against recorded responses; any version bump must pass them.
- Map Oxc nodes to TS nodes by `(file, start, end)` after UTF-8 → UTF-16 conversion; ask the
  checker for types/symbols at those positions. The Stator gate (`frontend/`) is ported to run on
  the Oxc AST plus those answers.

Fallbacks, in order: if IPC is too slow or lacks queries Stator needs, a tsgolint-style Go
backend (vendor `typescript-go` and add the queries in Go, as Oxc's `tsgolint` does — see its
`ARCHITECTURE.md`) still talked to over IPC; linking Go as a `c-shared` library into the Zig
binary is a last resort (two runtimes, GC, threads in one process).

Risks: the API is unstable; per-query IPC latency may dominate on large programs (batching
needed); TS 7 must agree with TS 6.0.3 on every verdict before phase 6.

## Gate parity (`statorc-zig gate`)

`statorc-zig gate [--mode=ts|js] [--node] <files...>` runs the unsupported-constructs gate on
each file and prints one line per finding: `file:line:col CODE [mode] message`. The format
matches the TypeScript compiler's output. `statorc-zig check` runs the parse first and then the gate,
and exits 1 when either one fails. The rules live in `src/gate.zig`. They use the same codes and
message text as `packages/compiler/src/frontend/gate.ts` and `docs/DIAGNOSTICS.md`.

The Zig core has no type checker yet (phase 3, tsgo), so only the **syntactic** rules are ported:

| Code | Mode | Construct | Phase |
|---|---|---|---|
| STA1002 | ts | a `.js`/`.cjs`/`.mjs`/`.jsx` file in ts mode | never |
| STA1101 / STA1206 | ts / js | `eval(...)` | never / Phase 8 |
| STA1103 / STA1206 | ts / js | `new Function(...)` | never / Phase 8 |
| STA1104 | ts | `var` | never |
| STA1105 / STA1202 | ts / js | `arguments` | never / Phase 5 |
| STA1106 / STA1203 | ts / js | `new Proxy(...)` | never / Phase 8 |
| STA1109 | both | `with` | never |
| STA1110 | ts; js without `--node` | `require()`, `module.exports`, `__filename`, `__dirname` | never |
| STA1112 | both | decorators | never |
| STA1113 | both | an extensionless relative import or re-export specifier | never |
| STA1201 | both | `for await`, `async function*` | Phase 5 |
| STA1207 | both | `import()` with a non-literal specifier | Phase 8 |
| STA1212 | both | `Symbol(...)` | Phase 5 |
| STA1213 | both | BigInt literals | Phase 5 |

The Zig gate does **not** reject anything the TypeScript compiler supports. In particular, the constructs
added by feat/realworld-gate-pass are accepted, and a unit test in `gate.zig` pins this. Those constructs are builtin constructors and prototypes as values, `.constructor`, `call`/`apply`,
`satisfies`, for-of over an existing binding, `Number.isFinite`/`isNaN` and
`ArrayBuffer.isView` (docs/VALUE.md §4.27).

Known gaps, which close when bindings and types arrive:
- The bridge does not export Oxc's symbol table yet, so a user binding that shadows `require`, `eval`, `Symbol` or `arguments` is still flagged.
- Every type-directed STA12xx rule, and STA1001/STA1003, is still TypeScript-only.

On the real-world corpus, the result matches the TypeScript pipeline:
- ms passes in ts mode.
- dequal passes under `--mode=js` and gets STA1002 in ts mode.
- minimist passes under `--mode=js --node` and gets STA1110 without `--node`.
