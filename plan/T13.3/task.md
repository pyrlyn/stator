---
status: todo
priority: P3
complexity: 3
readiness: 0%
agent:
---

# T13.3. The render API and a recording renderer

Depends on T13.0; lands before T13.4. The `Renderer` interface in `packages/webapi`, and a
recording renderer in `packages/tests` that prints what it is handed, one line per command. It
is the test double for T13.1–T13.2 and the contract test every renderer must pass.

**Check:** golden fixtures dump the recorded stream for each T13.0 §4 property; a second renderer
can be written against the interface alone (`docs/WEBAPI-DESIGN.md` has the worked example).
