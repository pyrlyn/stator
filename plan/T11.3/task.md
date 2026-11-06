---
status: in progress
priority: P1
complexity: 3
readiness: 100%
agent:
---

# T11.3. `packages/std`: the N1 modules

Depends on T11.1, T11.2. Zig backings, POSIX first (STD.md §4). Errors throw with a stable
`code` (STD.md §3).

| Module | Functions |
| --- | --- |
| `std/process` (extend) | `argv`, `execPath`, `platform`, `arch`, `ppid`, `hrtimeNs`, `memoryUsage`, `exitCode` |
| `std/fs` (extend) | `open`/`read`/`write`/`close` on fds, `readdir`, `realpath`, `utimes`, `exists`, bytes reads (`unlink`, `rmdir` and UTF-8 text reads landed with T11.2) |
| `std/os` | `platform`, `arch`, `release`, `hostname`, `homedir`, `tmpdir`, `cpuCount`, `totalMemory`, `eol` |
| `std/io` | `stdin`/`stdout`/`stderr` fds, `write`, `read`, `isatty`, `terminalSize` |
| `std/hash` | `sha256`, `sha1`, `md5` over bytes or strings; `randomBytes` |
| `std/encoding` | UTF-8 / latin1 / base64 / base64url / hex ↔ bytes |

**In progress** — Claude Code / opus-5-5. Execution plan, three PRs in this order, each with its
own Check evidence (a golden per module it lands). Steps 1 and 2 land with plan-notes 309:

1. `std/os` + `std/io`. `io` writes flush C stdio first so `console.log` and `io.write` keep
   program order. New §3 codes `EBADF` and `ENOTTY`. Bytes first crossed through a byte channel
   (one FFI call per byte); T11.3a replaced it with the extern table's `Uint8Array` row.
2. `std/encoding` + `std/hash`: encoding is strict TypeScript over `Uint8Array` (no OS edge;
   a string never crosses the C-string boundary, so a NUL survives); hash is Zig's
   `std.crypto` (`Sha256`, `Sha1`, `Md5`) over the `Uint8Array` row (T11.3a), `randomBytes` is
   `std.Io`'s secure random filling a caller-sized view.
3. `std/process` + `std/fs` extensions: `argv` needs `int main(int argc, char **argv)` from the
   emitter and a runtime slot (plan-notes 294); fd calls own a second lifetime (STD.md §9.3).

Each step: `zig/<module>.zig`, `src/<module>.ts`, `src/native/<module>.d.ts`, a Node twin in
`golden/std-oracle/`, a `std_<module>` golden, subset rows in both modes, unit-test ranges for
nondeterministic values, docs/STD.md §3/§5 and docs/SUBSET.md rows.

**Check:** a golden per module against Node's equivalent (nondeterministic results — `hostname`,
`pid`, `randomBytes` — proved by unit-test ranges, as `test:builtins` carves them out).
