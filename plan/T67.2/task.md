---
status: todo
priority: P2
complexity: 5
readiness: 0%
agent:
---

# T67.2. `stator-engine build --target=wasm`: JavaScript and TypeScript to WebAssembly

The creator's direction (2026-11-08): the engine must be able to compile JS and TS to
WebAssembly. The engine's front half stays as it is (stator-ts erases types, the bytecode
compiler makes templates); this card adds a backend that turns templates into a Wasm module, next
to the native one T67 builds on pyrlyn/jit.

Open questions for the creator before the plan is written: whether the module carries the
runtime (`libjsrt.a` and pyrlyn/gc compiled to wasm32) or targets WasmGC references; which host
it runs on (WASI, the browser, both); and whether untyped code may fall back to an interpreter
compiled into the module.

Done means `stator-engine build --target=wasm file.ts -o file.wasm` produces a module that runs
the engine's test scripts with the same output as `stator-engine run`.

Check: the engine's scripts run through the `.wasm` output and compare equal with `run`.
