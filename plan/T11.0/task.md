---
status: in progress
priority: P1
complexity: 3
readiness: 100%
agent:
---

# T11.0. Research: what `--node` means and what it costs

Docs only. The output is `docs/research/node-mode.md`. Every fact in it carries its primary
source: the URL plus the version or the date it was checked. The research answers these
questions:

1. **Surface, measured rather than guessed.** Which Node globals and `node:*` modules a corpus
   actually uses, in priority order. Start from the `tsc` bundle (plan-notes 286), then add a
   few popular CLIs. Cover sync vs async `fs`, and what `ts.sys` needs.
2. **Mode shape.** Is `--node` a third `--mode` or a platform flag orthogonal to `ts`/`js`? How
   does it stay a policy layer above the frontend gate (§0.8)? Cover file acceptance, the
   diagnostic table, and ambient types (`@types/node` or our own declarations).
3. **CommonJS semantics.** A literal `require("x")` as a module-graph edge; `module.exports` and
   `exports` interop with ESM; `__dirname` and `__filename`; `require.resolve`. Computed
   `require(expr)`, which is how `tsc` loads plugins, is a Phase 8 question. CommonJS cycles
   are legal and expose partially built exports, which conflicts with `STA3001`.
4. **Backing.** Which built-ins can sit on `std` (T10.1) C functions, and which need libuv or an
   event loop on Task 4.6's machinery. Cover how prior art handles this: Bun's and Deno's Node
   compatibility, Static Hermes, Porffor, and Node SEA / pkg (which bundle Node rather than
   compile ahead of time).
5. **Oracle.** How goldens prove Node parity for I/O: byte-exact stdout and stderr, exit codes,
   the filesystem side effects. Is a slice of Node's own test suite a usable conformance
   ratchet, the way Test262 is?
6. **Diagnostics.** Which codes `docs/DIAGNOSTICS.md` must allocate, and whether `STA1110`
   narrows to "never outside `--node`". Codes are never reused or renumbered.
7. **Cost and verdict.** An effort estimate per slice, and a go / no-go recommendation.

**Creator's constraint (2026-10-02): two layers, `std` first.** Stator gets its own base
libraries for files, network, processes, time, OS information and the like, as typed `std/*`
modules backed by C (the §11b A model, extended past T10.1's v0 table). `node:*` modules are
thin wrappers over `std`, never C of their own. So the research must answer, per Node module the
corpus needs, which `std` module and functions would back it. T10.1's `std/fs`, `std/process`
and `std/time` are the start, and `std/net`, `std/child_process`-style spawning and an event
loop are likely new rows.

**Execution plan.**
1. Measure the corpus with a TypeScript-API scanner (`packages/tests/` is not touched; the
   script and its raw output go under `docs/research/node-mode/`). Count `require` /
   `node:` specifiers, `process.*` / `Buffer.*` / timer uses, and the members used per
   module. The corpus is `tsc` 6.0.3 plus other bundled CLIs in this repo's `node_modules`, with
   versions recorded.
2. Primary-source research, run in parallel:
   - Node 26 docs: the module surface, CommonJS loading and cycles, `process`, `Buffer`.
   - Prior art: Bun, Deno, Static Hermes, Porffor, Node SEA / pkg.
   - Backing: libuv, and how other systems stdlibs layer files, net and processes.
   - The oracle: Node's own test suite layout.
3. Write `docs/research/node-mode.md`. It holds the `std` layer table (module → functions → C
   backing), the `node:*` → `std` mapping, the mode shape, CommonJS semantics, the oracle,
   diagnostics, cost per slice and the go / no-go.

**Status:** execution steps 1–3 are done — `docs/research/node-mode.md`, corpus under
`docs/research/node-mode/`, summary in plan-notes 288. The Check stays open until the creator's
decision is recorded.

**Check:** `docs/research/node-mode.md` exists with sources for every fact and ends in a
go / no-go recommendation; the creator's decision is recorded in `plan-notes.md`. If the answer
is go, the T11.1+ cards are written here, and §0, `STA1110` and §11b A are edited in the same
change.
