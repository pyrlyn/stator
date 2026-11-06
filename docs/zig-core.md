# Zig compiler (T41)

`packages/compiler-zig/` is the Stator compiler rewritten in Zig 0.17 on top of
stator-ts (`packages/transpiler`), which supplies the parser, the binder and the
type checker. It replaces `packages/compiler` (TypeScript, on the `typescript` 6.0.3 API) once every
stage is at parity. Until then `stator build` still runs the TypeScript compiler, which also serves
as the oracle every Zig stage is measured against. Direction and evidence: `plan.md` T41,
`plan-notes.md` §393. It supersedes the Oxc bridge and `tsgo` client of §391–392.

## Layout

`src/` mirrors `packages/compiler/src`:

| Path | Stage | Measured by |
| --- | --- | --- |
| stator-ts `Session` | types, symbols, signatures, flags | `pnpm run test:typediff` |
| `src/frontend/gate*.zig`, `src/support/` | mode gate, diagnostics | `test:zigdiff` gate |
| `src/frontend/{program,graph,modules,location,std,node,narrowing,generics}.zig` | program loading, module graph | `packages/tests/zigdiff/program.ts` |
| `src/lower/` | TS AST → HIR | `test:zigdiff` lower |
| `src/hir/` | HIR model, JSON boundary, verifier | `test:zigdiff` verifier |
| `src/passes/` | rewrite, inline, constfold, dce | `test:zigdiff` passes |
| `src/codegen/` | C emitter | `test:zigdiff` codegen, byte for byte |
| `src/cli/` | flags, `stator.config.json`, build and explain drivers | `packages/tests/zigdiff/cli.ts` |
| `src/ffigen/` | the FFI binding generator | `packages/tests/zigdiff/ffigen.ts` |

### Shared helpers

Look here before writing a helper, since `pnpm run dupes` fails on a second copy. Before writing one
over the AST, look in stator-ts too (`stator_ts.syntax`, `stator_ts.binder`): `gate_api.isTypeNode`
and `skipParens` are its versions.

| Helper | What it does |
| --- | --- |
| `jstext` (`packages/jstext`, shared with stator-ts) | JavaScript text over WTF-8: `numberToString`, `isSpace`/`trim`, `utf16Length`, `compare`/`less`, `writeJsonString`, `CodePoints`, `Units` |
| `support/ast_walk.zig` | walks a stator-ts AST: `contains` and `collect` with a step function |
| `support/node_field.zig` | reads the field several AST node kinds share under one meaning |
| `support/names.zig` | name lists and C names: `contains`, `lessThan`, `isWord`, `isCIdentifier` |
| `support/package_root.zig` | `isInside` and `exists` for package paths |
| `passes/rewrite.zig` `visiting` | builds a `Rewriter` from a struct's `pub` `expression`, `statement` and `statements` hooks |
| `hir/types.zig` `leaf` | the payload-free `HType` leaves, one per tag |
| `hir/nodes.zig` `UpdatePlace.of` | the update target of an expression, or null |
| `hir/sample.zig` | hand-built HIR for unit tests: `node`, `literal`, `identifier`, `block`, `moduleOf` |
| `lower/boundary.zig` `maybeBoundary`, `boundaryCheck` | the boundary check at a narrowing point or an annotated edge |
| `lower/ctx.zig` `ex`, `st` | allocate an HIR expression or statement node |
| `ffigen/text.zig` `fmt` | allocating `format` for the binding generator |

The emitter (`codegen/emitter.zig`) is a file struct, so its methods are `e.line`, `e.fmt`, `e.slotAt`.

The stages talk to the oracle through a JSON dump of the HIR: `packages/tests/zigdiff/dump-hir.ts`
writes the TypeScript compiler's HIR after lowering and after the passes, and `src/hir/json.zig`
reads it. The format is in `packages/tests/zigdiff/HIR-JSON.md`.

## Build, run, test

```sh
cd packages/compiler-zig
zig build                          # zig-out/bin/statorc-zig
zig build test                     # unit tests of every stage
./zig-out/bin/statorc-zig --help   # same CLI as `stator`
```

stator-ts is the in-repo `packages/transpiler`, a path dependency in `build.zig.zon` (plan/T62), so
a fix to it lands in the same change as the compiler code that needs it. The `lib.*.d.ts` files
still come from `packages/compiler/node_modules/typescript/lib`.

From the repository root, with the pinned Node:

```sh
STATOR_ZIG=$PWD/packages/compiler-zig/zig-out/bin/statorc-zig pnpm run test:zigdiff
STATOR_TS=$PWD/packages/transpiler/zig-out/bin/stator-ts pnpm run test:typediff
```

Both ratchet against a `baseline.json` next to them and fail when a count gets worse. `zigdiff`
reports a stage the binary cannot run as `not ported`, never as passed. On macOS 27 mise's clang
cannot link against the SDK's `.tbd` files; linking Zig-emitted C used `CC=/usr/bin/clang`.

## Where it stands

Measured on the T41 branch over `packages/tests/subset` and `packages/tests/golden`:

| Stage | Result |
| --- | --- |
| Types (`typediff`, 736 fixtures) | 36886/36886 expression types identical, 0 degraded |
| Gate | 1469/1506 identical; the rest are stator-ts checks not yet reported (STA0012), JSDoc and bundler cases |
| Lower | 1127/1148 identical, 10 different, 11 refused (bundler and package paths) |
| Verifier | 4590/4590 |
| Passes | 1148/1148 |
| Codegen | 1147/1147 byte-identical; all 491 golden programs built from Zig-emitted C match Node |
| CLI | 595/609 cases identical: 12 need TS2882 in stator-ts, 2 are `--emit-header` |

## Not ported

`frontend/export.ts` (library headers, `--emit=lib` and `--emit-header` write nothing yet),
`frontend/vendor.ts` and the bundler adapter path, the Ink TUI, OpenTelemetry, and
`STATOR_COMPILE_TIMING`. `packages/vite-stator` calls `statorc/api` in process; with a Zig
compiler it has to call the binary through a JSON protocol instead.

## Enable / disable

Nothing in the shipping pipeline calls the Zig compiler. CI does not build it yet. To remove it,
delete `packages/compiler-zig/`, `packages/tests/zigdiff/` and the `zig-core:test` and
`test:zigdiff` scripts.
