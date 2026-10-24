# ARCHITECTURE.md — how Stator works (diagrams)

Getting started is the [project README](../README.md). This file is the diagram gallery.

UML-style views of the pipeline defined in `plan.md` §2. That section is the authority; these
diagrams visualize it and may not contradict it.

Diagram **source** is D2 in [`architecture/`](architecture/) (not Mermaid). The SVGs next to the
`.d2` files are the GitHub-visible render. After editing a `.d2` file, regenerate:

```
d2 --layout=elk docs/architecture/pipeline.d2 docs/architecture/pipeline.svg
d2 docs/architecture/build.d2 docs/architecture/build.svg
d2 --layout=elk docs/architecture/packages.d2 docs/architecture/packages.svg
d2 docs/architecture/values.d2 docs/architecture/values.svg
```

`d2` is a docs tool (`brew install d2`), not part of `pnpm run ci`.

## 1. Compile pipeline (component view)

One pipeline, two modes. Mode is a policy layer at the frontend gate; nothing below it knows the
mode existed (plan §0.8).

In `js` mode a graph that imports a package or holds a CommonJS file takes one detour first
(T12.1, `docs/BUNDLER.md`): the dependencies are bundled into one virtual module and the program
is reloaded over it. Below the gate the vendor module is one more `js` file.
Under `--node` a program whose modules read their own location (`import.meta.url`, the vendor
module's `__filename`) is reloaded once more, over a rewrite that turns each read into a run-time
call (T11.5, `docs/MODES.md` §6).

![Compile pipeline](architecture/pipeline.svg)

Source: [`architecture/pipeline.d2`](architecture/pipeline.d2)

## 2. A `stator build` invocation (sequence view)

![Build sequence](architecture/build.svg)

Source: [`architecture/build.d2`](architecture/build.d2)

`STATOR_COMPILE_JOBS` above 1 compiles the emitted C as several translation units before the
link (docs/TOOLCHAIN.md). The sequence is still emit, then clang, then link.

Diagnostics short-circuit: any `STA` error at the gate stops the build with code + span + mode;
`stator explain` runs the same front half and reports per-construct verdicts
(`static | dynamic | error | not-yet`) instead of continuing to codegen.

## 3. Module dependencies (package view)

Arrows mean "imports from". The two structural invariants are the point of this diagram.

![Package dependencies](architecture/packages.svg)

Source: [`architecture/packages.d2`](architecture/packages.d2)

Invariants:
- **`ts.Type` stops at `src/frontend/`** — everything downstream speaks HType only.
- **Mode stops at the gate** — a pass or the emitter needing the mode means the design is wrong (plan §0.8).
- Generated C touches values only through `jsrt_value.h` accessors; every generated function opens
  `JSRT_FRAME(n)` and pops it on every exit path, including landing pads.
- **`std` is resolved and linked, never imported** — `frontend` maps `std/*` to `packages/std`'s
  sources and `cli` adds `libjsrt_std.a` only for a program that imports one (docs/STD.md §6).
  Nothing in `packages/compiler` imports `packages/std`. Thread/sync wrappers call the private
  boxed ABI in the runtime Zig core (THREADS.md); other native backings stay in `libjsrt_std.a`.
- **`node` is resolved, never imported** — under `--node` only, `frontend` maps `node:*` and the
  bare built-ins to `packages/node`'s sources (docs/MODES.md §6), strict TypeScript over `std/*`
  that compiles like any user module. Nothing in `packages/compiler` imports `packages/node`.
- **`vite-stator` is loaded, never imported** — it imports `statorc/api` and `vite`; the compiler
  loads it by module name (`--bundler=vite`, the `js`-mode default) only when a program imports a
  package (docs/BUNDLER.md §5). Nothing in `packages/compiler` imports a bundler (plan §0.9).

## 4. Value flow at a type boundary (activity view)

Why typed code is fast and untyped code still works (plan §1, §2):

![Value flow at a type boundary](architecture/values.svg)

Source: [`architecture/values.d2`](architecture/values.d2)
