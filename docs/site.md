---
title: Stator
tagline: An ahead-of-time compiler from TypeScript and JavaScript to native binaries.
repo: https://github.com/pyrlyn/stator
install: "git clone https://github.com/pyrlyn/stator && cd stator && mise install && pnpm install --frozen-lockfile && pnpm run runtime"
version: "0.0.0"
status: "Research compiler · no release yet"
accent: "#5B7CFF"
accentLight: "#3D5CE5"
order: 8
---

<!-- Website copy for the pyrlyn project site, copied to pyrlyn/landing as
content/projects/stator.md; front matter follows CONTENT_CONTRACT.md in that repository.
Sources (checked 2026-10-14): README.md, docs/README.md, docs/MODES.md and docs/CONFIG.md; version from package.json (no release yet, hence status). accent and accentLight are the dark and light --st-accent in docs/brand. -->

## Overview

Stator compiles TypeScript and JavaScript ahead of time to native binaries. Typed code compiles to
unboxed machine values; untyped code compiles too, through a dynamic representation (NaN-boxed
values, shape tables, inline caches), instead of being rejected. One pipeline; the mode is a
policy layer on top.

Stator is a research compiler under active construction, with no release yet. It is not an
npm-ecosystem drop-in and not a production JavaScript runtime.

## Features

- **Two modes.** `--mode=ts` (default) takes `.ts` only and makes `any`, `eval`, `var` and `Proxy` compile errors; `--mode=js` compiles mixed `.js` and `.ts`, untyped code dynamically.
- **Unboxed values.** Inside checked code values stay unboxed wherever the checker can infer a type.
- **explain.** Per-construct verdicts — `static`, `dynamic`, `error` or `not-yet` — as text or JSON.
- **Config file.** `stator.config.json`, validated against a generated JSON Schema; the command line overrides it.
- **Bundling.** In `js` mode `vite-stator` bundles `node_modules` into one module, and its Vite plugin makes `vite build` write the native binary.
- **FFI.** Calling C from TypeScript through an extern surface.

## Install

Build from the repository with the pinned toolchain:

```bash
git clone https://github.com/pyrlyn/stator && cd stator && mise install && pnpm install --frozen-lockfile && pnpm run runtime
```

## Usage examples

Compile a TypeScript file, or JavaScript in `js` mode (in a checkout, before `pnpm run build`, the CLI is `node packages/compiler/src/cli/main.ts`):

```bash
stator build app.ts -o app
stator build app.js -o app --mode=js
```

See what compiles statically, dynamically, or not yet:

```bash
stator explain app.ts --json
```

## Links

- Repository: <https://github.com/pyrlyn/stator>
- Documentation: <https://github.com/pyrlyn/stator/tree/main/docs>
- License: your choice of GNU GPLv3 or a commercial license (see <https://github.com/pyrlyn/stator#license>)
