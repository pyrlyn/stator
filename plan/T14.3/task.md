---
status: in progress
priority: P2
complexity: 5
readiness: 100%
agent: Claude Code / claude-opus-5-5
---

# T14.3. Wiring: `eval`, `new Function`, and the `Interpret` node

Depends on T14.2. The frontend gate stops emitting `STA1206` in `js` mode and marks the construct
"interpret". Lowering stores the bindings a direct `eval` can see in cells and passes scope
descriptors (`docs/INTERPRETER.md` §3). The emitter links `libjsrt_interp.a` only when an
`Interpret` node exists. The work lands in the compiler that is current at the time
(`packages/compiler`, or plan/T41's Zig port once it has replaced it). Decision tests flip
`not-yet` → `dynamic` in the same commit (AGENTS.md). The Test262 runner's host becomes a compiled
`js` program that hands each test to an indirect `eval` (§8).

**Check:** a `js` program that mixes compiled modules, a direct `eval` reading a caller's local,
an indirect `eval` and a `new Function` runs exactly as under Node, and golden fixtures `eval_*`
match Node byte-for-byte. Binaries without an `Interpret` node, and every `ts`-mode binary, are
byte-identical in size to before. `test:asan` is clean.

## Execution plan

1. **Interpreter entry points** (`packages/interpreter/src/capi.zig`, `builtins.zig`, `compile.zig`,
   `vm.zig`):
   - `jsrt_interp_global(name)`: a property of the interpreter's global object (`eval`,
     `Function`).
   - `jsrt_interp_eval_direct(src, count, names, cells, this)`: strict eval code whose free names
     resolve first to the caller's cells (`jsrt_value *` into a `JSRTEnv` or a module global),
     through new `load_ref`/`store_ref` ops over an environment of boxed cell pointers.
   - A working `Function` constructor over `parse.parseFunction`.
   - `$262` and `print` move out of the global object into the Test262 host.
2. **Frontend** (`gate.ts`, a new eval-visibility helper): `eval` and `Function` stop raising
   `STA1206` in `js` mode. Every binding visible at a direct `eval` is marked dynamic
   (`runtimeDynamicSymbols`) and forced into its owner's environment (`captures.ts`).
3. **HIR and lowering**: an `interpret` expression node in two forms. `global` is the
   interpreter's `eval` or `Function` as a value. `direct-eval` holds the argument and the visible
   bindings. The verifier checks the node.
4. **Emitter and link**: C for both forms (a stack array of cell addresses for the descriptor).
   `CompiledC.interp` adds `libjsrt_interp.a` to the link only when a node exists. `pnpm run
   runtime`, moon and CI build the archive.
5. **Tests**: flip the `STA1206` decision tests to `dynamic`; add golden `eval_*` fixtures; add
   unit tests for the link line and the lowering. Run `test:asan`, and compare sizes of binaries
   without an `Interpret` node against `main`.
6. **Test262 host**: a compiled `js` program reads the composed test and runs it through an
   indirect `eval`, with `$262` and `print` compiled. `test262/exec.zig` spawns it. Re-record the
   ratchet.
7. **Docs**: `INTERPRETER.md` §3, §8 and §9; `SUBSET.md`; `DIAGNOSTICS.md`; `MODES.md`; `HIR.md`;
   `AGENTS.md`; `toolchain.md`. Add a plan-notes entry for anything measured or changed.

Check: run `pnpm run ci`, `pnpm run test:asan` and the `eval_*` golden fixtures, compare sizes,
and re-ratchet `test262:interp-exec`.
