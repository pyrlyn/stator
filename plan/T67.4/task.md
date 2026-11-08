---
status: todo
priority: P2
complexity: 5
readiness: 0%
agent:
---

# T67.4. `stator-engine build --target=zig`: JavaScript and TypeScript to Zig source

The creator's direction (2026-11-08): the engine compiles JS and TS to Zig source, so a program
can be read, changed and built as a Zig project, and Zig's own cross-compilation and safety
modes apply to it.

The front half is shared: stator-ts erases types, the bytecode compiler makes templates (or the
compiler's typed HIR, for `ts`-mode input). This card adds a backend that prints a `.zig` file per
module, calling the runtime through its C ABI (`jsrt_value.h`, `jsrt.h`, as `zig translate-c`
already exposes them to the engine), and a `build.zig` that links `libjsrt.a`.

Open questions for the creator before the plan is written: whether the backend starts from the
engine's bytecode (every JS program, dynamic values throughout) or from `packages/compiler-zig`'s
typed HIR (unboxed values for typed code, as the C emitter does), or both; and whether the output
is meant to be edited by hand or only built.

Done means `stator-engine build --target=zig file.ts -o out/` writes Zig source that `zig build`
turns into a binary printing the same output as `stator-engine run file.ts`.

Check: the engine's test scripts, built through `--target=zig`, compare equal with `run`.
