> [!NOTE]
> This project is under active development. We need "testing volunteers": try it and report what breaks.

# Stator

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=listepo_stator&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=listepo_stator) [![Coverage](https://sonarcloud.io/api/project_badges/measure?project=listepo_stator&metric=coverage)](https://sonarcloud.io/component_measures?id=listepo_stator&metric=coverage) [![Tests](https://img.shields.io/sonar/tests/listepo_stator?server=https%3A%2F%2Fsonarcloud.io&compact_message)](https://sonarcloud.io/component_measures?id=listepo_stator&metric=tests)

An ahead-of-time compiler from TypeScript and JavaScript to native binaries.

Typed code compiles to unboxed machine values. Untyped code compiles too — through a dynamic representation (NaN-boxed values, shape tables, inline caches) — instead of being rejected or heroically analyzed. One pipeline; the mode is a policy layer on top.

This is a research compiler under active construction (Phase 5 of [`plan.md`](plan.md)). It is not an npm-ecosystem drop-in, and it is not a production JS runtime.

## Two modes

| | `--mode=ts` (default) | `--mode=js` |
|---|---|---|
| Inputs | `.ts` only | `.js` and `.ts` mixed |
| `any`, `eval`, `var`, `Proxy` | compile errors, permanently | untyped code is dynamic; `eval` is not-yet until Phase 8 |
| Speed | unboxed values inside checked code | same, wherever the checker can infer a type |

```
# Dev (no build step): run the CLI from TypeScript on the pinned Node
node packages/compiler/src/cli/main.ts build app.ts -o app
node packages/compiler/src/cli/main.ts build app.js -o app --mode=js
node packages/compiler/src/cli/main.ts explain app.ts --json

# After `pnpm run build`, the same commands are available as `stator …`
```

Every option can also live in a `stator.config.json` next to where you run the CLI, validated
against a generated JSON Schema; the command line overrides it, and `--no-config` ignores it.
Keys, precedence and an example: [`docs/CONFIG.md`](docs/CONFIG.md).

In `js` mode, `node_modules` packages go through a bundler: `vite-stator`, the default, bundles
them into one tree-shaken module, and its `stator()` Vite plugin makes `vite build` write the
native binary ([`examples/vite`](examples/vite), [`docs/BUNDLER.md`](docs/BUNDLER.md)).

`explain` reports per-construct verdicts: `static`, `dynamic`, `error`, or `not-yet`. Decision tests in `packages/tests/subset/` are that matrix.

## Develop

```
mise install
pnpm install --frozen-lockfile
pnpm run runtime    # libjsrt.a, then libjsrt_std.a
pnpm run ci         # the full gate
```

Pinned toolchain, every test harness and the runtime builds: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Docs

| | |
|---|---|
| [docs/README.md](docs/README.md) | index of the spec docs |
| [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) | how the pipeline works + usage examples |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | pipeline diagrams (D2) |
| [docs/MODES.md](docs/MODES.md) | `ts` vs `js` |
| [docs/SUBSET.md](docs/SUBSET.md) | what compiles, what is error, what is not-yet |
| [docs/VALUE.md](docs/VALUE.md) | NaN-boxing, shapes, GC rooting |
| [docs/FFI.md](docs/FFI.md) | calling C from TS: extern surface, ABI table, ownership |
| [docs/CONFIG.md](docs/CONFIG.md) | `stator.config.json` keys and precedence |
| [docs/BUNDLER.md](docs/BUNDLER.md) | `vite-stator` and `node_modules` in `js` mode |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | toolchain, test harnesses, runtime builds |
| [plan.md](plan.md) | roadmap (open work only) |
| [AGENTS.md](AGENTS.md) | conventions for humans and agents working in this repo |
| [CONTRIBUTING.md](CONTRIBUTING.md) | short contributor checklist |

## License

You can use this project under **any** of the following licenses, at your choice:

1. [GNU GPLv3](LICENSE): free for open source applications on any platform, including embedded systems.
2. [Royalty-free License](LICENSE-ROYALTY-FREE.md): free for proprietary desktop, mobile, and web applications, as long as you disclose that your application uses this project. Embedded systems are not covered.
3. [Commercial license](PRICING.md): for proprietary applications, including embedded systems, without the attribution requirement.

The typed standard library includes filesystem, environment, process, time, I/O, encoding and
hashing modules, plus OS threads (`std/thread`) and `Mutex`, `CondVar`, bounded `Channel<T>`
(`std/sync`). Public APIs are TypeScript; native primitives are Zig. See [STD.md](docs/STD.md)
and the ownership and scheduling contract in [THREADS.md](docs/THREADS.md).
