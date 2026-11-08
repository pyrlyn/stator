# T67. Done

`packages/interpreter` is now `packages/engine`, a JavaScript engine with two modes over one
bytecode, and a CLI, `stator-engine`.

- **interp**: the Phase-14 interpreter, unchanged in behavior; `libjsrt_interp.a`, `jsrt_interp.h`
  and the Test262 drivers work from the new path.
- **jit**: a baseline JIT on pyrlyn/jit (pinned by commit in `packages/engine/build.zig.zon`):
  stack-depth analysis, lowering to pyrlyn/jit IR with the operand stack kept in the GC-rooted
  frame window, inline double and boolean fast paths, the VM's own operations as helpers,
  compile on first call and cache on the template. Handlers, generators and async bodies stay
  interpreted. Design: `docs/ENGINE.md` §3.
- **CLI**: `stator-engine run [--mode=interp|jit] [--lang=js|ts|wasm] <file>`; TypeScript is erased
  by stator-ts (`packages/transpiler/src/erase.zig`); `wasm` and the `build` targets name
  plan/T67.3, T67.2 and T67.4.
- **Tests**: every interpreter unit test runs in both modes; JIT analysis tests compile real
  source; `packages/tests/engine/` holds a script corpus checked against the pinned Node in both
  modes plus the CLI contract, and the V8 benchmark.
- **Found and fixed**: stator-ts misread `a < 1, b >= 1` as type arguments (regression line in its
  parser test); `analyze.zig` leaked on rejected templates; the engine lacked `console` and
  `String.fromCharCode` (plan-notes 412).

The work is the `T67:` commits on the `t67-engine` branch, squash-merged by its pull request.

## Check

Run on Apple M3 Max, macOS 27.0, Node v26.7.0, Zig 0.17.1, 2026-11-08.

```text
$ pnpm run runtime && pnpm run interp:test
$ zig build test --build-file packages/engine/build.zig            (31 tests, both modes, exit 0)
$ pnpm run engine:test
engine: 54 passed, 0 failed
$ pnpm run engine:bench
| program | node (V8) ms | engine interp ms | engine jit ms | jit vs V8 | ...
| fib | 88.6 | 2439 | 996 | 11.23x | ...
| nbody | 55.9 | 98.7 | 32.3 | 0.58x | ...
| objects-churn | 77.4 | 2783 | 1187 | 15.33x | ...
$ pnpm run test:golden
golden: 525 fixtures — 525 passed, 0 failed
$ STATOR_TEST262=<corpus> pnpm run test262:interp-parse
test262-parse: 19162 / 23726 pass (80.76%)
```

`pnpm run typecheck`, `lint` (oxlint) and `dupes` were clean. Not verified: the x86-64 JIT path
compiles but has not run (no x86-64 host here).
