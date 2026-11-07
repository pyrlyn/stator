# packages/interpreter

The Phase-14 interpreter: Zig code inside the runtime that runs `eval`, `new Function` and
the `js`-mode code the compiler hands it. The design is in `docs/INTERPRETER.md`.

| Path | Holds |
| --- | --- |
| `src/parse.zig` | The parser front. `eval` source and `new Function`'s pieces go through stator-ts's parser (`packages/transpiler/src/parser.zig`), and the result is either the tree or the first early error. |
| `src/scope.zig` | One resolver pass per script: each binding becomes a frame register, a `JSRTEnv` slot (when an inner function captures it) or a global. |
| `src/bytecode.zig` | The instruction set: one byte per opcode, inline operands, and the per-function template (`Proto`) with its constant, name, function, IC and handler tables. |
| `src/compile.zig` | The stator-ts tree to bytecode, one `Proto` per function. A construct it does not take yet fails with `not yet supported by the interpreter: …`. |
| `src/vm.zig` | The dispatch loop. Frames, registers and operand stack live in collected memory; interpreted functions are runtime closures with one entry point. |
| `src/realm.zig` | The global object, the global lexical bindings, and the builtins that compiled code reaches only statically (the error constructors). |
| `src/gc.zig` | A Zig allocator over the runtime's collector, for everything the VM keeps. |
| `src/capi.zig` | The C ABI the runtime calls: `jsrt_interp_parse_script` and `jsrt_interp_eval_script`. Errors are left pending. |
| `test262/common.zig` | What both Test262 drivers share: metadata, modes, corpus walk, per-directory ratchet. |
| `test262/parse.zig` | Runs Test262's `test/language/` through the parse entry and ratchets the result against `test262-parse.json`. |
| `test262/run.zig` | Runs `test/language/` through the evaluator with the harness, one forked child per test, and ratchets against `test262-run.json`. |

The tests and drivers link `packages/runtime/build/libjsrt.a`; build it first with `pnpm run runtime`
(or pass `-Druntime=<path>`).

```bash
zig build test                    # unit tests (pnpm run interp:test)
zig build lib -Doptimize=ReleaseFast   # zig-out/lib/libjsrt_interp.a
zig build test262-parse -Doptimize=ReleaseFast -- [--corpus=<dir>] [--filter=<text>] [--failures] [--update]
zig build test262-run -Doptimize=ReleaseFast -- [same options]   # pnpm run test262:interp
```

The Test262 corpus comes from `pnpm run test262:fetch`, or from `$STATOR_TEST262` when that is
set. A `--filter` run checks a slice, so it neither gates nor records.
