---
status: todo
priority: P2
complexity: 5
readiness: 0%
agent:
---

# T14.3. Wiring: `eval`, `new Function`, and the `Interpret` node

Depends on T14.2. The frontend gate stops emitting `STA1206` in `js` mode and marks the construct
"interpret". Lowering materializes the scopes of functions that contain a direct `eval` (T14.0 §3).
The emitter links the package only when an `Interpret` node exists. Decision tests flip
`not-yet` → `dynamic` in the same commit (AGENTS.md).

**Check:** a `js` program that mixes compiled modules, a direct `eval` reading a caller's local,
an indirect `eval` and a `new Function` runs exactly as under Node. Binaries without an `Interpret`
node, and every `ts`-mode binary, are byte-identical in size to before. `test:asan` is clean.
