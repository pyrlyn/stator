---
status: todo
priority: P2
complexity: 5
readiness: 0%
agent:
---

# T67.3. A WebAssembly runtime in the engine: `.wasm` modules run from JavaScript and TypeScript

The creator's direction (2026-11-08): the engine gets a WebAssembly runtime that JS and TS code
uses, as V8 gives Node one. A script loads a module through the `WebAssembly` namespace
(`WebAssembly.Module`, `Instance`, `Memory`, `Table`, `Global`, `validate`, `compile`,
`instantiate`), calls its exports and passes JS functions in as imports; `stator-engine run
file.wasm` runs a module's start function or exported `_start` directly.

The runtime is Zig in `packages/engine` and reuses the engine's tiers: modules are decoded and
validated once, then run in an interpreter over Wasm's own stack machine and, in `jit` mode, are
lowered into pyrlyn/jit's IR like JS templates are. Linear memory and tables live outside the
collector; the JS wrappers around them are runtime objects.

Open questions for the creator before the plan is written: which proposals beyond the Wasm 2.0
core come first (SIMD, threads, exception handling, GC, memory64), and whether WASI is part of
this card or a later one.

Done means the `WebAssembly` JS API exists in both modes, the official spec testsuite's core
`.wast` files run through a driver with a ratcheted pass count, and a JS script that imports and
calls an exported function prints the same output on the engine as on the pinned Node.

Check: the spec-testsuite driver's ratchet holds, and the engine's Wasm interop scripts compare
equal with Node.
