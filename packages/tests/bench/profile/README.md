# CPU profiling: samply → speedscope

Measurement only. `run.ts` compiles every memory-benchmark program (`../memory/programs/*` plus
the shared `fib`, `nbody`, `json-roundtrip`, `string-churn` from `../programs`, the same set
`../memory/run.ts` measures) with stator, records each binary with
[samply](https://github.com/mstange/samply), and exports the profile to
[speedscope](https://www.speedscope.app) JSON plus a plain-text hot-spot summary that an agent
can read without a GUI.

## How it works

1. **Build.** `stator build <program> -o out/<program>/app` with `CC` pointed at
   `cc-profile.sh`, which adds `-fno-omit-frame-pointer -mno-omit-leaf-frame-pointer` to the
   normal clang line. Optimisation level and every other flag stay as the driver chooses
   (`-O2` by default), so the code profiled is the code shipped. Binaries are not stripped, so
   runtime (`jsrt_*`) and generated (`_jsrt_fn_N`) functions keep their names.
2. **Record.** `samply record --save-only --unstable-presymbolicate -r $PROFILE_RATE` writes
   `profile.json.gz` (Firefox Profiler format) and `profile.json.syms.json` (symbol table for
   every sampled library). No browser is opened.
3. **Convert.** `to_speedscope.py` resolves frame addresses through the sidecar, writes
   `profile.speedscope.json` (one sampled profile per thread) and `summary.txt` (CPU share per
   library, top N functions by self and by total/inclusive time). Samples are weighted by
   thread CPU time (`threadCPUDelta`), so Boehm GC's parked marker threads do not dominate;
   `--weight samples` gives raw sample counts instead.
4. `out/SUMMARY.md` concatenates all summaries.

## Run

```sh
brew install samply              # or: cargo install --locked samply
pnpm run runtime                 # libjsrt.a
pnpm run bench:profile           # = node packages/tests/bench/profile/run.ts
```

Env: `PROFILE_PROGRAMS=fib,nbody` (filter), `PROFILE_RATE` (Hz, default 4000), `PROFILE_TOP`
(default 25), `PROFILE_OUT` (default `packages/tests/bench/profile/out/`, gitignored),
`SAMPLY`, `PYTHON`, `CC` (real compiler behind the wrapper).

Output per program in `out/<program>/`: `app`, `profile.json.gz`, `profile.json.syms.json`,
`profile.speedscope.json`, `summary.txt`.

View: drop `profile.speedscope.json` on <https://www.speedscope.app>, or
`samply load out/<program>/profile.json.gz` for the Firefox Profiler.
Convert any other samply profile by hand:
`python3 to_speedscope.py profile.json.gz out.speedscope.json --summary summary.txt`.

## Enable / disable

Opt-in only: nothing in `pnpm test`, CI or the normal build calls it, and it changes no
compiler or runtime code. Remove the `bench:profile` script to disable; delete `out/` to drop
results.

## Test

`PROFILE_PROGRAMS=fib pnpm run bench:profile` should finish in seconds and print a summary
where `_jsrt_fn_0` (the compiled `fib`) has ~99 % total time. A frame shown as `lib+0xADDR`
means the library has no symbol for that address.

## Limitations

- macOS/Linux only (samply). On macOS the wrapper calls `/usr/bin/clang` unless `CC` is set,
  because a custom `CC` disables the driver's stale-ld/SDK retry for the mise clang.
- Homebrew's `libgc` exports only public symbols, so internal mark-loop functions appear as
  `libgc.1.5.6.dylib+0x…`; build bdw-gc from source with `-g` for full names.
- `libdyld.dylib+0x7e54/0x7e5c` are the thread-local-variable accessor (`tlv_get_addr`), i.e.
  the cost of runtime `threadlocal` state.
- `__psynch_cvwait` with CPU weight is time Boehm's parallel marker threads spend in
  condition-variable hand-offs during collection, i.e. GC overhead, not program work.
- `hello`, `json-roundtrip`, `string-churn` run for only a few milliseconds, so their profiles
  are mostly process start-up and are noisy; use them for start-up cost, not hot loops.
- One run per program; sampling at 4 kHz gives statistical, not exact, percentages.
