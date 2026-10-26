# Memory benchmark: stator vs JS/TS-to-binary compilers

`run.ts` compiles the same programs with stator and with every other tool that turns
JavaScript/TypeScript into a standalone executable, runs each executable several times, and
records **median peak RSS**, **binary size**, median wall time, and the non-system shared
libraries the executable still needs. The latest recording is in [`RESULTS.md`](RESULTS.md);
raw per-run numbers are in `results/*.json`.

It complements `../record.ts` (runtime geomean vs interpreters, max RSS): this harness
compares against *compilers to binaries*, uses the median instead of the max, and adds
memory-specific programs.

## Programs

| Program | What it stresses |
|---|---|
| `programs/hello.ts` | baseline resident size of the runtime itself |
| `programs/objects-churn.ts` | 10M short-lived `{a,b}` objects: allocation rate, GC keeps RSS flat |
| `programs/objects-retained.ts` | 1M live `{id,name}` objects: per-object live-heap footprint |
| `../programs/fib.ts`, `nbody.ts`, `json-roundtrip.ts`, `string-churn.ts` | the shared bench set (`ffi-sqrt` is stator-only, `startup.ts` is empty) |

Each program's stdout is byte-compared (ANSI colour stripped) with `node <program>.js`; a
tool that prints the wrong answer is reported as a failure, not measured.

## Tools compared

| Tool | Category | Why it is in the set |
|---|---|---|
| stator | TS/JS → C → native | this repo |
| [Perry](https://github.com/PerryTS/perry) | TS → LLVM native, own runtime + GC | closest typed-TS AOT competitor (plan.md §0.1) |
| [scriptc](https://scriptc.dev) (Vercel Labs) | TS → LLVM native | type-directed AOT, same lane (plan.md §0.1) |
| [Porffor](https://porffor.dev) | JS → Wasm → C → native | direct-to-native AOT |
| QuickJS `qjsc` | JS → bytecode embedded in C → native | JS-to-C classic, tiny interpreter |
| Static Hermes `shermes` | JS → native via C/LLVM | Meta's typed-JS AOT (plan.md §0.1) |
| `bun build --compile` | bundle + embedded JavaScriptCore | most-used "JS to single binary" |
| `deno compile` | bundle + embedded V8 | same, V8 |
| Node SEA (`node --build-sea`) | Node binary + injected blob | official Node single executable |
| [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) | Node base binary + snapshot FS | maintained fork of Vercel's `pkg` |
| nexe | Node base binary + payload | listed for completeness; see limitations |

Tools that need plain JS get the TypeScript source with types stripped by
`node:module.stripTypeScriptTypes`; the TS-native tools get the `.ts` file.

## How to run

```sh
pnpm run runtime                 # build libjsrt.a (stator needs it)
pnpm run bench:memory            # = node packages/tests/bench/memory/run.ts
```

Install the analogs (none are project dependencies; keep them outside the repo):

```sh
mkdir -p ~/bench-tools && cd ~/bench-tools
npm i @perryts/perry scriptc porffor @yao-pkg/pkg nexe
brew install quickjs bun          # deno via mise/brew; Node SEA uses the pinned node
# Static Hermes has no package: build the static_h branch with cmake + ninja
git clone --depth 1 -b static_h https://github.com/facebook/hermes && \
  cmake -S hermes -B hermes-build -G Ninja -DCMAKE_BUILD_TYPE=Release && ninja -C hermes-build
```

Environment knobs:

| Variable | Effect |
|---|---|
| `BENCH_TOOLS_BIN` | `:`-separated dirs prepended to `PATH` (e.g. `~/bench-tools/node_modules/.bin`) |
| `BENCH_TOOLS` | comma list to enable only some tools (e.g. `stator,scriptc,perry`); default all |
| `BENCH_PROGRAMS` | comma list of program names; default all |
| `BENCH_RUNS` | runs per program (default 5) after one discarded warm-up run |
| `SHERMES_VERSION` | label for the Static Hermes build (it reports no release version) |

**Enable / disable.** It is opt-in: nothing in CI or `pnpm test` runs it. A tool not on
`PATH` is recorded as `not installed` and skipped; disable one explicitly by leaving it out of
`BENCH_TOOLS`. Delete `results/` files you do not want to keep.

**Test.** A quick smoke check: `BENCH_RUNS=1 BENCH_PROGRAMS=hello BENCH_TOOLS=stator pnpm
run bench:memory` must print a table with a stator number and no failure line.

## How it is measured

- Peak RSS: `/usr/bin/time -l` (`maximum resident set size`, bytes on macOS) or `-f %M`
  (KiB on Linux), per run; the table shows the median of `BENCH_RUNS` runs.
- Wall time: `process.hrtime` around the spawn, median; it includes ~1 ms of `time` overhead.
- Binary size: `stat` of the produced executable. Shared libraries are **not** included —
  see the dependency list in `RESULTS.md` (stator needs Homebrew `libgc`, shermes its
  `libhermesvm`), so their size is understated relative to self-contained tools.

## Limitations

- One machine, one recording; wall times are directional (the box was not idle).
- nexe 5.0.0-beta.4 ships no prebuilt base for macOS arm64 / Node 26 and would need a
  from-source Node build (`--build`, ~1 h); it is reported as a failure.
- RSS includes code pages of embedded runtimes (V8/JSC), which is what users pay but not
  what the program allocates. Internal heap counters are not compared because each runtime
  reports them differently.
- `objects-retained` keeps strings of the form `item-N`; runtimes that intern or rope them
  get an advantage that is legitimate but workload-specific.

## Recommendations for stator

See [`RECOMMENDATIONS.md`](RECOMMENDATIONS.md): concrete items to make stator binaries faster
and smaller in memory, each citing the measurement in `RESULTS.md` that motivates it.
