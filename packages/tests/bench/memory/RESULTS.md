# Memory benchmark results

Recorded 2026-10-25T20:08:36.591Z on Apple M3 Max (darwin 27.0.0, arm64), median of 5 runs.

## Tools

| Tool | Kind | Version |
|---|---|---|
| stator | TS/JS -> C -> native (this repo) | working tree |
| perry | TS -> LLVM native | perry 0.5.1520 |
| scriptc | TS -> LLVM native (Vercel Labs) | 0.4.4 |
| porffor | JS -> Wasm -> C -> native | alpha 19 (0c135ce 2026-10-21) |
| qjsc | JS -> QuickJS bytecode in C -> native | QuickJS version 2026-06-04 |
| shermes | JS -> Static Hermes native | Static Hermes static_h@393a539 (2026-10-23, source build) |
| bun-compile | bundle + embedded JSC runtime | 1.3.14 |
| deno-compile | bundle + embedded V8 runtime | deno 2.9.7 (stable, release, aarch64-apple-darwin) |
| node-sea | Node single executable (embedded V8) | v26.7.0 |
| pkg | @yao-pkg/pkg (Node base binary + snapshot fs) | 6.24.0 |
| nexe | nexe (Node base binary + payload) | 5.0.0-beta.4 |

## Peak RSS, MB (median)

| Tool | hello | objects-churn | objects-retained | fib | json-roundtrip | nbody | string-churn |
|---|---:|---:|---:|---:|---:|---:|---:|
| stator | 3.19 | 4.28 | 131.4 | 3.17 | 3.39 | 3.17 | 4.30 |
| perry | 5.61 | 7.23 | 138.0 | 5.77 | 14.4 | 5.67 | 6.00 |
| scriptc | 1.83 | 1.83 | 72.0 | 1.88 | 2.13 | 1.84 | 1.98 |
| porffor | 1.91 | 37.2 | 113.9 | 1.92 | 2.64 | 1.92 | 19.5 |
| qjsc | 2.23 | 2.25 | 159.1 | 2.28 | 2.33 | 2.27 | 2.33 |
| shermes | 9.75 | 9.73 | 140.0 | 9.73 | 9.83 | 9.73 | 11.6 |
| bun-compile | 21.9 | 43.8 | 128.4 | 27.9 | 22.1 | 29.2 | 26.3 |
| deno-compile | 23.4 | 31.8 | 190.3 | 28.8 | 24.0 | 32.0 | 27.8 |
| node-sea | 48.7 | 58.0 | 216.6 | 55.0 | 49.0 | 57.6 | 57.0 |
| pkg | 38.8 | 45.0 | 165.8 | 42.7 | 38.8 | 46.1 | 44.1 |
| nexe | fail | fail | fail | fail | fail | fail | fail |

## Binary size, MB

| Tool | hello | objects-churn | objects-retained | fib | json-roundtrip | nbody | string-churn |
|---|---:|---:|---:|---:|---:|---:|---:|
| stator | 0.27 | 0.27 | 0.27 | 0.27 | 0.29 | 0.27 | 0.27 |
| perry | 14.2 | 14.2 | 14.3 | 14.2 | 14.2 | 14.2 | 14.2 |
| scriptc | 0.09 | 0.09 | 0.11 | 0.11 | 0.25 | 0.09 | 0.10 |
| porffor | 0.11 | 0.13 | 0.14 | 0.13 | 0.19 | 0.13 | 0.14 |
| qjsc | 0.76 | 0.76 | 0.76 | 0.76 | 0.76 | 0.76 | 0.76 |
| shermes | 0.05 | 0.05 | 0.05 | 0.05 | 0.05 | 0.05 | 0.05 |
| bun-compile | 60.5 | 60.5 | 60.5 | 60.5 | 60.5 | 60.5 | 60.5 |
| deno-compile | 64.5 | 64.5 | 64.5 | 64.5 | 64.5 | 64.5 | 64.5 |
| node-sea | 136.9 | 136.9 | 136.9 | 136.9 | 136.9 | 136.9 | 136.9 |
| pkg | 57.6 | 57.6 | 57.6 | 57.6 | 57.6 | 57.6 | 57.6 |
| nexe | fail | fail | fail | fail | fail | fail | fail |

## Wall time, ms (median)

| Tool | hello | objects-churn | objects-retained | fib | json-roundtrip | nbody | string-churn |
|---|---:|---:|---:|---:|---:|---:|---:|
| stator | 16 | 1066 | 909 | 1369 | 10 | 38 | 15 |
| perry | 46 | 115 | 923 | 65 | 31 | 40 | 34 |
| scriptc | 39 | 85 | 62 | 50 | 77 | 112 | 226 |
| porffor | 117 | 329 | 472 | 189 | 29 | 46 | 27 |
| qjsc | 23 | 1957 | 560 | 706 | 19 | 57 | 30 |
| shermes | 41 | 89 | 360 | 337 | 72 | 82 | 98 |
| bun-compile | 166 | 195 | 258 | 157 | 80 | 216 | 80 |
| deno-compile | 37 | 110 | 139 | 127 | 48 | 92 | 39 |
| node-sea | 88 | 117 | 130 | 131 | 35 | 106 | 138 |
| pkg | 39 | 60 | 145 | 89 | 39 | 44 | 42 |
| nexe | fail | fail | fail | fail | fail | fail | fail |

## Run-time shared-library dependencies (non-system)

- **stator**: `/opt/homebrew/opt/bdw-gc/lib/libgc.1.dylib`
- **perry**: none (self-contained)
- **scriptc**: none (self-contained)
- **porffor**: none (self-contained)
- **qjsc**: none (self-contained)
- **shermes**: `@rpath/libshermes_console.dylib`, `@rpath/libhermesvm.dylib`
- **bun-compile**: none (self-contained)
- **deno-compile**: none (self-contained)
- **node-sea**: none (self-contained)
- **pkg**: none (self-contained)

## Failures

- **nexe** / hello: Error: https://github.com/nexe/nexe/releases/download/v3.3.3/mac-arm64-26.7.0 is not available, create it using the --build flag
- **nexe** / objects-churn: Error: https://github.com/nexe/nexe/releases/download/v3.3.3/mac-arm64-26.7.0 is not available, create it using the --build flag
- **nexe** / objects-retained: Error: https://github.com/nexe/nexe/releases/download/v3.3.3/mac-arm64-26.7.0 is not available, create it using the --build flag
- **nexe** / fib: Error: https://github.com/nexe/nexe/releases/download/v3.3.3/mac-arm64-26.7.0 is not available, create it using the --build flag
- **nexe** / json-roundtrip: Error: https://github.com/nexe/nexe/releases/download/v3.3.3/mac-arm64-26.7.0 is not available, create it using the --build flag
- **nexe** / nbody: Error: https://github.com/nexe/nexe/releases/download/v3.3.3/mac-arm64-26.7.0 is not available, create it using the --build flag
- **nexe** / string-churn: Error: https://github.com/nexe/nexe/releases/download/v3.3.3/mac-arm64-26.7.0 is not available, create it using the --build flag
