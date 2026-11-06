---
status: todo
priority: P2
complexity: 5
readiness: 0%
agent:
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
