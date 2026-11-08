# packages/engine

Stator's JavaScript engine in Zig (plan/T67). Its `interp` mode is the Phase-14 interpreter: Zig
code inside the runtime that runs `eval`, `new Function` and the `js`-mode code the compiler hands
it, designed in `docs/INTERPRETER.md`. Its `jit` mode compiles the same bytecode to native code
through pyrlyn/jit. Until T67 this package was `packages/interpreter`.

| Path | Holds |
| --- | --- |
| `src/parse.zig` | The parser front. `eval` source and `new Function`'s pieces go through stator-ts's parser (`packages/transpiler/src/parser.zig`), and the result is either the tree or the first early error. |
| `src/capi.zig` | The C ABI the runtime calls. Errors are left pending through `jsrt_throw_error`. |
| `src/bytecode.zig` | The bytecode format: opcodes, inline operands, function templates. |
| `src/compile.zig` | stator-ts's tree to bytecode, with scope analysis. A construct it does not take yet is reported as unsupported, and nothing runs. |
| `src/vm.zig` | The machine. Values are the runtime's `jsrt_value`, and every operation is a runtime helper. A generator or async function suspends by copying its window into a heap environment and resumes through the runtime's generator and promise machinery. |
| `src/builtins.zig` | The global object an interpreted script runs against, plus the generator and async-generator prototypes. |
| `src/interp.zig` | `runScript` and `evalScript`: parse, compile and run a script against the global object. |
| `src/engine.zig` | `run`: a `.js` or `.ts` source (TypeScript erased by stator-ts's `erase.zig`) in `interp` or `jit` mode (`docs/ENGINE.md`). |
| `src/cli.zig` | `stator-engine run [--mode=interp\|jit] [--lang=js\|ts\|wasm] <file>` (`docs/ENGINE.md` §5). |
| `src/jit/` | The baseline JIT: `analyze.zig` (which templates, stack depths), `lower.zig` (bytecode → pyrlyn/jit IR), `layout.zig` (block order for backend liveness), `helpers.zig` (the VM operations native code calls), `jit.zig` (compile on first call), `timing.zig` (opt-in compilation stage timing). |
| `src/rt.zig` | The runtime's C ABI, translated from `packages/runtime/src/jsrt_c.h`. |
| `test262/parse.zig` | Runs Test262's `test/language/` through the parse entry and ratchets the result against `test262-parse.json`. |
| `test262/host.ts` | The Test262 host: strict TS compiled `--mode=js --node`, so a test runs in the interpreter through an indirect `eval`, and `print` and `$262` are compiled code. |
| `test262/exec.zig` | Runs the same tests through the compiled host, one child process per test and mode, and ratchets the result against `test262-exec.json`. |
| `test262/common.zig` | What the two drivers share: test metadata, modes, the corpus walk, the ratchet. |

```bash
zig build test                    # unit tests, both modes (pnpm run interp:test)
zig build cli -Doptimize=ReleaseFast   # zig-out/bin/stator-engine
zig build lib -Doptimize=ReleaseFast   # zig-out/lib/libjsrt_interp.a
zig build test262-parse -Doptimize=ReleaseFast -- [--corpus=<dir>] [--filter=<text>] [--failures] [--update]
zig build test262-exec -Doptimize=ReleaseSafe -- [--corpus=<dir>] [--filter=<text>] [--host=<binary>] [--failures] [--update]
```

The unit tests link `../runtime/build/libjsrt.a` from `pnpm run runtime`; pass `-Druntime=<path>`
to link another flavor. `test262-exec` links neither: it runs `build/test262-host`, which
`pnpm run test262:interp-exec` compiles from `test262/host.ts` first (or `--host=<binary>`).
That host links `build/lib/libjsrt_interp.a`, so after changing `src/` rebuild it with
`just interp` first, or the run measures the old interpreter.

The Test262 corpus comes from `pnpm run test262:fetch`, or from `$STATOR_TEST262` when that is
set. A `--filter` run checks a slice, so it neither gates nor records.

The script corpus and the V8 benchmark live in `packages/tests/engine/` (`pnpm run engine:test`,
`pnpm run engine:bench`); `src/bench.zig` times the `bench/` programs inside one process
(`pnpm run engine:bench:zig`).

From the repository root, `node packages/tests/engine/startup.ts --rounds=9` measures cold
process startup and compilation separately, comparing Stator with V8 Sparkplug and TurboFan.
`STATOR_JIT_TRACE=1` adds nanosecond compilation-stage records to the existing trace. The
measurement boundaries, before/after binary overrides and limitations are in `docs/ENGINE.md` §4.2.
