# Development

Toolchain setup and every check. Conventions are in [AGENTS.md](../AGENTS.md).

## Setup

Pinned in [`.node-version`](../.node-version) and [`mise.toml`](../mise.toml): Node 26.7.0, pnpm 12.3.4, LLVM clang 21.1.8, just 1.58.0. Full table: [`docs/TOOLCHAIN.md`](TOOLCHAIN.md).

```
mise install
pnpm install --frozen-lockfile
pnpm run runtime    # libjsrt.a, then libjsrt_std.a (the std/* backings)
```

Boehm GC is optional (`pkg-config bdw-gc`); without it the runtime still builds, with a bump allocator. ICU is a separate `just -f packages/runtime/justfile -d packages/runtime runtime-intl` feature build.

## Commands

```
pnpm run ci              # typecheck, lint, dupes, coverage, subset, golden, sanitizers, leak
pnpm run test            # unit tests (vitest)
pnpm run test:impact     # only the tests your changes reach (all harnesses; needs test:impact:record)
pnpm run test:subset     # feature × mode decision matrix
pnpm run test:golden     # compile + run vs the pinned Node, byte-for-byte
pnpm run test:selfhost   # Stator explains (and builds) its own packages; per-code counts may only shrink
pnpm run test262         # Test262 slice (CI heartbeat; corpus fetched separately)
pnpm run test:node-suite # Node's own test/parallel slice through vitest (fetches its pinned corpus)
pnpm run differential    # fuzzer vs Node
just -f packages/runtime/justfile -d packages/runtime runtime             # libjsrt.a (clang -O2 -Werror; thin LTO where the linker can read it)
just -f packages/runtime/justfile -d packages/runtime runtime-asan        # ASan/UBSan archive
just -f packages/std/justfile -d packages/std std                         # libjsrt_std.a, the std/* backings (Zig)
```

Dev runs TypeScript directly on the pinned Node — no `pnpm run build` step for the CLI. GitHub Actions runs `pnpm run ci` plus a Test262 heartbeat on every push; nightly fuzz and weekly benches are `.github/workflows/nightly.yml`.

Self-hosting plan (V-style bootstrap): [SELF-HOSTING.md](SELF-HOSTING.md).
