# packages/interpreter

The Phase-14 interpreter: Zig code inside the runtime that runs `eval`, `new Function` and
the `js`-mode code the compiler hands it. The design is in `docs/INTERPRETER.md`.

| Path | Holds |
| --- | --- |
| `src/parse.zig` | The parser front. `eval` source and `new Function`'s pieces go through stator-ts's parser (`packages/transpiler/src/parser.zig`), and the result is either the tree or the first early error. |
| `src/capi.zig` | The C ABI the runtime calls. Errors are left pending through `jsrt_throw_error`. |
| `test262/parse.zig` | Runs Test262's `test/language/` through the parse entry and ratchets the result against `test262-parse.json`. |

```bash
zig build test                    # unit tests (pnpm run interp:test)
zig build lib -Doptimize=ReleaseFast   # zig-out/lib/libjsrt_interp.a
zig build test262-parse -Doptimize=ReleaseFast -- [--corpus=<dir>] [--filter=<text>] [--failures] [--update]
```

The Test262 corpus comes from `pnpm run test262:fetch`, or from `$STATOR_TEST262` when that is
set. A `--filter` run checks a slice, so it neither gates nor records.
