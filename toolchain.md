# Toolchain

Pins below are the ones in `mise.toml` and the package manifests. `docs/TOOLCHAIN.md` is the longer note (CI stages, environment variables, vendored C, Boehm, ICU) and matches these pins (plan-notes 359).

## Programs

| Program | How to install | Why here | Source |
| --- | --- | --- | --- |
| node | mise (`mise.toml`, 26.7.0) | Dev runtime; the CLI runs TypeScript directly | https://github.com/nodejs/node |
| pnpm | mise (`npm:pnpm`, 12.3.4) | Workspace installs; also `packageManager` in the root `package.json` | https://github.com/pnpm/pnpm |
| moon | mise (`npm:@moonrepo/cli`, 2.5.4) | Task graph over the pnpm workspace | https://github.com/moonrepo/moon |
| just | mise (`mise.toml`, 1.58.0) | Builds `libjsrt.a` and `libjsrt_std.a` | https://github.com/casey/just |
| clang, llvm | mise (`conda:clang` and `conda:llvm`, 21.1.8, Linux and macOS) | Compiles the runtime and the emitted C | https://github.com/llvm/llvm-project |
| zig | mise (`mise.toml`, 0.16.0, Linux and macOS) | Memory core in `libjsrt.a` and the `std/*` backings | https://github.com/ziglang/zig |
| jactionlint | mise (`mise.toml` pins `github:jdx/jactionlint` 2.0.2) | Lint the workflows and composite actions (`static analysis` job, the pre-push hook and `mise x -- jactionlint`) | https://github.com/jdx/jactionlint |
| hk | mise (`mise.toml` pins 2.5.0) | Runs jactionlint as a pre-push hook (`hk.pkl`) | https://github.com/jdx/hk |
| shellcheck | mise (`mise.toml` pins 0.11.0; CI uses the runner image's copy) | Checks `run:` scripts inside jactionlint | https://github.com/koalaman/shellcheck |

## pnpm

| Package | Where | Source | Why here |
| --- | --- | --- | --- |
| typescript 6.0.3 | `packages/compiler` dependency; devDependency of the other TypeScript packages and the root | https://www.npmjs.com/package/typescript | In-process parse and check; pinned to 6.0.3, not the 7.x Go port |
| typebox 1.3.36 | `packages/compiler` | https://www.npmjs.com/package/typebox | `stator.config.json` schema and validation |
| jsonc-parser 3.3.1 | `packages/compiler` | https://www.npmjs.com/package/jsonc-parser | Locates a syntax error in `stator.config.json` |
| dotenv 18.0.6 | `packages/compiler` | https://www.npmjs.com/package/dotenv | Loads the project `.env` for the CLI |
| ink 8.0.0 | `packages/compiler` | https://www.npmjs.com/package/ink | CLI rendering |
| react 19.3.0 | `packages/compiler` | https://www.npmjs.com/package/react | Ink's renderer |
| @types/react 19.3.0 | root devDependency | https://www.npmjs.com/package/@types/react | Types for the Ink UI |
| @opentelemetry/api 1.9.1 | `packages/compiler` | https://www.npmjs.com/package/@opentelemetry/api | Opt-in tracing (`STATOR_OTEL`) |
| @opentelemetry/exporter-trace-otlp-http 0.222.0 | `packages/compiler` | https://www.npmjs.com/package/@opentelemetry/exporter-trace-otlp-http | OTLP HTTP export |
| @opentelemetry/resources 2.11.0 | `packages/compiler` | https://www.npmjs.com/package/@opentelemetry/resources | Trace resource attributes |
| @opentelemetry/sdk-trace-node 2.11.0 | `packages/compiler` | https://www.npmjs.com/package/@opentelemetry/sdk-trace-node | Node trace SDK |
| vite 8.3.3 | `packages/vite-stator` and `examples/vite` devDependencies; peer `^8.3.2` | https://www.npmjs.com/package/vite | Default bundler; `stator()` plugin |
| vitest 5.0.3 | root and `packages/tests` | https://www.npmjs.com/package/vitest | Unit tests (`pnpm run test`) |
| @types/node 26.6.3 | root devDependency | https://www.npmjs.com/package/@types/node | Node types for the compiler and harnesses |
| oxlint 1.86.0 | root devDependency | https://www.npmjs.com/package/oxlint | Lint |
| oxlint-tsgolint 7.0.2003 | root devDependency | https://www.npmjs.com/package/oxlint-tsgolint | Type-aware oxlint backend |
| oxfmt 0.71.0 | root devDependency | https://www.npmjs.com/package/oxfmt | Format check |
| c8 12.0.0 | root devDependency | https://www.npmjs.com/package/c8 | V8 coverage for `pnpm run test:coverage` |
| cpd 5.4.0 | root devDependency | https://www.npmjs.com/package/cpd | Copy-paste check (`pnpm run dupes`) |
| execa 10.0.1 | root devDependency and `packages/tests` | https://www.npmjs.com/package/execa | Spawns the CLI from unit tests |
| astro ^7.3.5 | `site/` | https://www.npmjs.com/package/astro | Landing page; own lockfile, not `pnpm run ci` |
| @fontsource/ibm-plex-sans 5.3.0 | `site/` | https://www.npmjs.com/package/@fontsource/ibm-plex-sans | Self-hosted sans face |
| @fontsource/ibm-plex-mono 5.3.0 | `site/` | https://www.npmjs.com/package/@fontsource/ibm-plex-mono | Self-hosted mono face |
| playwright-core 1.63.0 | `site/` devDependency | https://www.npmjs.com/package/playwright-core | Browser check of the built site |

`memfs` is not a dependency. It was removed from the root and `packages/tests` manifests (plan-notes 353).
