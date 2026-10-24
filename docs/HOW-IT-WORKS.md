# HOW-IT-WORKS.md — how Stator compiles and how to use it

Getting started commands also live in the [project README](../README.md). Spec
authority for open work is [`plan.md`](../plan.md); diagrams are in
[`ARCHITECTURE.md`](ARCHITECTURE.md). This page explains the **current**
pipeline and walks through real examples in the tree — no invented features.

## What Stator is

Stator is an ahead-of-time compiler: TypeScript and/or JavaScript in, a native
binary out. It is a research compiler under active construction (see
[`plan.md`](../plan.md)), not an npm-ecosystem drop-in and not a production JS
runtime.

Two modes share **one** pipeline. Mode is only a frontend policy (which files
are accepted, which diagnostics fire, how unresolved code is typed). Nothing
below the gate is allowed to branch on mode ([`MODES.md`](MODES.md), plan §0.8).

| | `--mode=ts` (default) | `--mode=js` |
|---|---|---|
| Inputs | `.ts` only | `.js` and `.ts` mixed |
| `any`, `eval`, `var`, `Proxy`, … | compile errors (`eval` permanently) | untyped code goes dynamic; `eval` is `not-yet` until Phase 8 |
| Speed | unboxed values in checked code | same wherever the checker can infer a type |

`--node` is a second frontend policy, orthogonal to the mode: the Node
platform. Under it `node:*` and bare built-ins (`path`) resolve to
`packages/node`, strict TypeScript over `std`, and a built-in that has not
landed is a `not-yet` naming T11.6 ([`MODES.md`](MODES.md) §6).

Per-construct verdicts (`static` / `dynamic` / `error` / `not-yet`) are the
language of the subset matrix ([`SUBSET.md`](SUBSET.md)) and of
`stator explain`.

## Pipeline (current)

```
[js mode, graph imports a package or, under --node, holds a CommonJS file]
  bundler adapter (--bundler, default vite) → one vendor ESM module + source map
typescript API (parse + type-check, in-process; the vendor module joins as __stator_vendor__.js)
[--node, a module reads its location] import.meta.url, the vendor module's __filename → run-time calls
  → mode gate
  → typed HIR
  → passes (monomorphize, boundary-insert, const-fold, DCE, inline, …)
  → C emitter
  → clang
  → link libjsrt.a (+ libjsrt_std.a when the program imports std/*)
  → native binary
```

`STATOR_COMPILE_JOBS` (docs/TOOLCHAIN.md) can compile that C as several units. The emitter
still writes one C string; the split happens after emit, and `1` keeps the single clang
invocation.

Package layout:

- `packages/compiler` (`statorc`) — CLI, frontend, HIR, passes, C emitter
- `packages/runtime` — C11 + Zig memory core → `libjsrt.a` (not an npm package)
- `packages/std` (`@stator/std`) — the `std/*` modules: strict TS surface + Zig backings → `libjsrt_std.a` (docs/STD.md)
- `packages/tests` — unit, subset, golden, differential, Test262, leak, …

The bundle step runs only in `js` mode and only when the loaded graph needs it. Its output is
one virtual module the program reads from memory, and the project's package imports are rewritten
in place to name it, line for line; a diagnostic inside it is reported at the package's own file
and line through the bundle's source map (`src/cli/bundler.ts`, `src/frontend/vendor.ts`,
`src/support/sourcemap.ts`). The library entry `statorc/api` (`compile`, `vendorEntry`) runs the
same driver.

Under `--node` one more frontend step follows: every `import.meta.url`, `.filename` and
`.dirname`, and every free `__filename`/`__dirname` the bundler left in the vendor module, is
rewritten in place into a call to `packages/node`'s location helpers, which answer relative to the
executable when the program runs (`src/frontend/location.ts`, [`MODES.md`](MODES.md) §6). The
program reloads over the rewrite, so no build-machine path reaches the binary.

Invariants that matter when reading code or docs:

1. **`ts.Type` stops at `src/frontend/`** — downstream speaks HType only
   ([`HIR.md`](HIR.md)).
2. **Mode stops at the gate** — a pass or the emitter needing the mode means
   the design is wrong.
3. **Values cross the codegen↔runtime boundary only through `jsrt_value.h`**
   ([`VALUE.md`](VALUE.md)): NaN-boxing, shapes, ICs, `JSRT_FRAME` GC rooting.

Picture gallery (D2 → SVG): [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Setup (once)

Pinned in [`.node-version`](../.node-version) and [`mise.toml`](../mise.toml).
Full table: [`TOOLCHAIN.md`](TOOLCHAIN.md).

```sh
mise install
pnpm install --frozen-lockfile
just -f packages/runtime/justfile -d packages/runtime runtime
```

If bare `node --version` disagrees with `.node-version`, prefix CLI runs with
`mise exec node --` (`pnpm run ci` refuses to start otherwise).

Boehm GC is optional (`pkg-config bdw-gc`); without it the runtime still
builds with a bump allocator. ICU is a separate
`just -f packages/runtime/justfile -d packages/runtime runtime-intl` feature.

## CLI usage

Dev runs the CLI from TypeScript on the pinned Node — no `pnpm run build`
required. After `pnpm run build`, the same entry is the `stator` bin from
`packages/compiler`.

```sh
# Build a typed entry (default --mode=ts)
node packages/compiler/src/cli/main.ts build app.ts -o app

# Build a JS / mixed-graph entry
node packages/compiler/src/cli/main.ts build app.js -o app --mode=js

# A js graph that imports packages: they are bundled first (docs/BUNDLER.md)
node packages/compiler/src/cli/main.ts build app.js -o app --mode=js --bundler=vite

# Per-construct verdicts (what the subset matrix tests use)
node packages/compiler/src/cli/main.ts explain app.ts --json

# Useful flags (see CLI help / AGENTS.md Commands)
#   --emit=c --keep-c     keep generated C for inspection
#   --emit=lib --emit-header=u.h -o libu.a  a static library, header and .pc for C (docs/FFI.md §8)
#   --mode=ts|js          frontend policy
#   --node                the Node platform: node:* resolves to packages/node
#   --bundler=vite|none|<module>  js mode: the bundler for packages and (--node) CommonJS files
#   --config=<path>       options from a JSON file (default ./stator.config.json)
#   --no-config           ignore stator.config.json
```

Every flag above can also be a key in `stator.config.json`; the command line wins. See
[CONFIG.md](CONFIG.md).

Useful local gates (not a product feature list — just what the repo runs):

```sh
pnpm run test            # unit (vitest)
pnpm run test:impact     # tests your changes reach (per-test coverage map)
pnpm run test:subset     # feature × mode decision matrix
pnpm run test:golden     # compile + run vs pinned Node, byte-for-byte
pnpm run test:selfhost   # Stator explains (and builds) its own packages; per-code counts may only shrink
pnpm run ci              # full local gate before claiming work done
```

## Example: todo (both modes, one shared core)

Path: [`examples/todo/`](../examples/todo/). `shared.ts` is a small typed task
store. Two entries prove the product story:

| Entry | Mode | Point |
|---|---|---|
| `main-ts.ts` | `ts` | shared core compiles statically |
| `main-js.js` | `js` | untyped code imports the same typed core (mixed graph) |

```sh
node packages/compiler/src/cli/main.ts build examples/todo/main-ts.ts -o todo-ts
node packages/compiler/src/cli/main.ts build examples/todo/main-js.js -o todo-js --mode=js
./todo-ts && ./todo-js
```

Ground truth is the pinned Node on the same entries — binaries must match
stdout **byte-for-byte**:

```sh
node examples/todo/main-ts.ts
node examples/todo/main-js.js
```

Details: [`examples/todo/README.md`](../examples/todo/README.md).

## Example: FFI bindings

Path: [`examples/ffi/`](../examples/ffi/). Manual `.d.ts` bindings and small
drivers for libm / sqlite / `stat` illustrate the extern surface described in
[`FFI.md`](FFI.md). Generator requirements and refusals (varargs, function
pointers, int64 widening, …) are recorded in
[`examples/ffi/NOTES.md`](../examples/ffi/NOTES.md) — read that before inventing
ABI behavior.

## Where to go next

| If you need… | Read |
|---|---|
| Mode rules | [`MODES.md`](MODES.md) |
| What compiles / errors / not-yet | [`SUBSET.md`](SUBSET.md) |
| Diagnostic codes (`STA…`) | [`DIAGNOSTICS.md`](DIAGNOSTICS.md) — sole allocator |
| Value representation / GC frames | [`VALUE.md`](VALUE.md) |
| Numeric / printing | [`NUMERIC.md`](NUMERIC.md) |
| HIR shape | [`HIR.md`](HIR.md) |
| Pins and native libs | [`TOOLCHAIN.md`](TOOLCHAIN.md) |
| Calling C from TS | [`FFI.md`](FFI.md) |
| Agent / contributor conventions | [`../AGENTS.md`](../AGENTS.md), [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |

When behavior, CLI, subset, diagnostics, toolchain, or architecture change,
update the matching docs in the **same** change (see `AGENTS.md` golden rules).
