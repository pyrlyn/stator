---
status: in progress
priority: P1
complexity: 5
readiness: 5%
agent: Claude Code / claude-opus-5-5
---

# T67. `packages/engine`: a JavaScript engine with an interpreter and a JIT, and its CLI

The creator's direction (2026-11-08): a JavaScript engine in Zig under `packages/engine`, built
from what Stator already has, with two execution modes:

- **interp** — small, light and fast, in the spirit of PrimJS: the Phase-14 bytecode interpreter.
- **jit** — native code from the same bytecode; the long-term goal is to beat V8, measured, never
  claimed.

The engine is shaped so TypeScript and WebAssembly can be added as input languages later. It is
also a CLI, `stator-engine`, which runs a `.js` file, or a `.ts` file after stator-ts erases its
types, and which the benchmark uses to compare the engine with V8 (the pinned Node).

What it reuses, and nothing parallel to it:

- `packages/interpreter` moves to `packages/engine` (the creator's choice): the parser front on
  stator-ts, the bytecode compiler, the VM and the builtins become the engine's interpreter tier.
  `libjsrt_interp.a`, `jsrt_interp.h` and the Test262 drivers keep working from the new path.
- Values, objects and the collector are the runtime's (`libjsrt.a`): `jsrt_value`, shapes and ICs,
  and pyrlyn/gc, which T66 compiled into the runtime. The engine adds no second heap.
- The JIT lowers bytecode into https://github.com/pyrlyn/jit's IR and compiles it with its
  register allocator and backends (AArch64, x86-64), pinned in `build.zig.zon` by commit.
- TypeScript input goes through stator-ts's JS emitter (`packages/transpiler/src/emit.zig`).

Done means:

1. `packages/engine` holds what `packages/interpreter` held, every reference to the old path is
   updated, and `pnpm run interp:test`, `pnpm run test262:interp-parse` and the golden fixtures
   that call the interpreter pass as before.
2. `stator-engine run [--mode=interp|jit] [--lang=js|ts] <file>` runs a script; `--lang` is taken
   from the extension when absent; `wasm` is a named, rejected language until T67.3 runs it.
3. In `jit` mode, a function whose opcodes the baseline JIT takes runs as native code (AArch64 and
   x86-64); any other function runs in the interpreter, with the same observable result.
4. A benchmark runs the same scripts on the pinned Node (V8), `stator-engine --mode=interp` and
   `--mode=jit`, and records the times with the machine, versions and flags.

## Execution plan

1. Card and `plan.md` heading (§11f), `plan-notes.md` 409.
2. `git mv packages/interpreter packages/engine`; update `package.json`, moon, `.gitignore`,
   `.sonarcloud.properties`, `packages/compiler/src/cli/build.ts`, `jsrt_interp.h`, the docs and
   `AGENTS.md`'s repo map. Archives (`done.md`, closed plan-notes entries) keep the old path.
3. `build.zig.zon`: pyrlyn/jit by commit (`zig fetch --save`); `toolchain.md` row (GPL-3.0, as
   Stator is).
4. `src/jit/`: stack-depth analysis of a template, lowering to `pyrlyn_jit.ir` (values stay in
   the frame window the collector already roots; number and boolean fast paths inline, the rest
   through the VM's own helpers), compile on first call in `jit` mode, cache on the template;
   functions with handlers, generators or async bodies stay interpreted.
5. `src/engine.zig` (mode, language) and `src/cli.zig` (`stator-engine`); `transpile` in stator-ts.
6. Tests (`zig build test`, run by `pnpm run interp:test`):
   - `src/jit/` unit tests: stack-depth analysis, eligibility (handlers, generators, async and
     unsupported opcodes stay interpreted), and compiled templates for arithmetic, comparisons,
     branches, loops, locals and calls, each checked against the interpreter's result;
   - double fast paths: NaN canonicalization, `-0`, int32 overflow into doubles, mixed
     number/string operands falling back to helpers;
   - exceptions thrown from a helper inside JIT code reach the interpreter's handler;
   - a script corpus under `packages/engine/tests/` (`.js` and `.ts` with `.out` files) run by
     `stator-engine` in `interp` and `jit` mode, both equal to the pinned Node's output;
   - CLI tests: `--lang` from the extension, `wasm` rejected with its message, a missing file and
     a syntax error exit non-zero with a diagnostic.
7. `packages/engine/bench/`: scripts and a strict-TS runner vs Node; results recorded.
8. Docs: `docs/ENGINE.md`, `docs/INTERPRETER.md` §9, `packages/engine/README.md`, architecture
   diagram if the package graph changes.

## Check

```bash
pnpm run runtime && pnpm run interp:test
zig build --build-file packages/engine/build.zig cli -Doptimize=ReleaseFast
node packages/engine/bench/run.ts
pnpm run test:golden
```
