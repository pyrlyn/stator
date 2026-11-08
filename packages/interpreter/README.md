# packages/interpreter

The Phase-14 interpreter: Zig code inside the runtime that runs `eval`, `new Function` and
the `js`-mode code the compiler hands it. The design is in `docs/INTERPRETER.md`.

| Path | Holds |
| --- | --- |
| `src/parse.zig` | The parser front. `eval` source and `new Function`'s pieces go through stator-ts's parser (`packages/transpiler/src/parser.zig`), and the result is either the tree or the first early error. |
| `src/capi.zig` | The C ABI the runtime calls. Errors are left pending through `jsrt_throw_error`. |
| `src/bytecode.zig` | The bytecode format: opcodes, inline operands, function templates. |
| `src/compile.zig` | stator-ts's tree to bytecode, with scope analysis. A construct it does not take yet is reported as unsupported, and nothing runs. |
| `src/vm.zig` | The machine. Values are the runtime's `jsrt_value`, and every operation is a runtime helper. |
| `src/builtins.zig` | The global object an interpreted script runs against. |
| `src/interp.zig` | `runScript` and `evalScript`: parse, compile and run a script against the global object. |
| `src/rt.zig` | The runtime's C ABI, translated from `packages/runtime/src/jsrt_c.h`. |
| `test262/parse.zig` | Runs Test262's `test/language/` through the parse entry and ratchets the result against `test262-parse.json`. |
| `test262/host.ts` | The Test262 host: strict TS compiled `--mode=js --node`, so a test runs in the interpreter through an indirect `eval`, and `print` and `$262` are compiled code. |
| `test262/exec.zig` | Runs the same tests through the compiled host, one child process per test and mode, and ratchets the result against `test262-exec.json`. |
| `test262/common.zig` | What the two drivers share: test metadata, modes, the corpus walk, the ratchet. |

```bash
zig build test                    # unit tests (pnpm run interp:test)
zig build lib -Doptimize=ReleaseFast   # zig-out/lib/libjsrt_interp.a
zig build test262-parse -Doptimize=ReleaseFast -- [--corpus=<dir>] [--filter=<text>] [--failures] [--update]
zig build test262-exec -Doptimize=ReleaseSafe -- [--corpus=<dir>] [--filter=<text>] [--host=<binary>] [--failures] [--update]
```

The unit tests link `../runtime/build/libjsrt.a` from `pnpm run runtime`; pass `-Druntime=<path>`
to link another flavor. `test262-exec` links neither: it runs `build/test262-host`, which
`pnpm run test262:interp-exec` compiles from `test262/host.ts` first (or `--host=<binary>`).

The Test262 corpus comes from `pnpm run test262:fetch`, or from `$STATOR_TEST262` when that is
set. A `--filter` run checks a slice, so it neither gates nor records.
