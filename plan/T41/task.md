---
status: in progress
priority: P1
complexity: 5
readiness: 70%
agent: Claude Code / claude-opus-5-5
---

# T41. Rewrite the compiler in Zig on top of stator-ts

Creator's direction, plan-notes 393: the compiler moves to Zig, with
[stator-ts](https://github.com/pyrlyn/stator-ts) as its parser and type checker. It supersedes the
Oxc bridge and the `tsgo --api` client of plan-notes 391 and 392. A gap in stator-ts is fixed there,
with a fixture checked against real `tsc`, and its `tests/ts7/passing.txt` ratchet must not drop.

`packages/compiler` stays as the oracle, on `typescript` 6.0.3, until parity. Every stage proves
itself against it:

| Stage | Zig path | Proof |
| --- | --- | --- |
| Types | stator-ts `Session` | `pnpm run test:typediff` |
| Gate, diagnostics | `src/frontend/gate*.zig`, `src/support/` | `explain --json` identical |
| HIR model | `src/hir/` | every dump round-trips through `src/hir/json.zig` |
| Verifier, passes | `src/hir/verify.zig`, `src/passes/` | post-pass dump identical |
| Codegen | `src/codegen/` | `--emit=c` byte-identical |
| Lowering, type bridge | `src/lower/`, `src/frontend/types.zig`, `generics.zig` | HIR dump identical |
| CLI, module graph | `src/cli/`, `src/frontend/` | same output, exit codes, file sets |

State and the per-stage counts: `docs/zig-core.md`. Open: the gate and lowering differences, `frontend/export.ts`, `frontend/vendor.ts` and the bundler path, and the 68 jscpd clones the port still adds (plan-notes 393).

Consequences to settle before the switch: `packages/vite-stator` calls the binary instead of
`statorc/api`; Task 6.19, T61 and T36–T40 lose their meaning for the compiler itself, while `std` and
`node` stay Stator-compiled; 77 test and support files import compiler internals.

**Check:** `pnpm run test:zigdiff` shows every stage at parity with no `not ported` entry, then
`test:subset`, `test:golden`, `test:asan` and `test:typediff` pass with the Zig binary and
`packages/compiler` deleted, and with `typescript` removed from runtime dependencies.
