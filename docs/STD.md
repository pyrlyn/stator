# STD.md — Stator's `std` library

> **Status: v0 implemented** (plan.md §11c T11.2, T11.3): `std/env`, `std/path`, `std/process`,
> sync `std/fs`, `std/time`, `std/os`, `std/io`, `std/encoding` and `std/hash` live in
> `packages/std` and compile into any program that imports them. `std/sync` and `std/thread` wait
> for T10.2.
> On any disagreement between this file and plan.md §11b/§11c, the plan wins (§15.3).

`std` is a **first-party systems-style standard library**, not a Node compatibility layer and
not user FFI (Phase 7). Users import typed modules (`std/env`, `std/fs`, …); the compiler
resolves the edge to the library's own TypeScript, which calls Zig backings in
`libjsrt_std.a`. Where `std` crosses into native code, Phase 7's extern rules (docs/FFI.md)
apply unchanged — `std` is written against the same surface a user's FFI is.

## 1. Module path: `std/*`

Imports spell `std/env`, `std/fs`, … — a **reserved prefix**, not a package and not
`@stator/std`. Rationale: `@stator/std` reads as an npm package, and bare package imports are
refused (STA1214, phaseless) — a std spelling that looks like a package invites exactly the
confusion that refusal exists to prevent.

One module owns the prefix: `packages/compiler/src/frontend/std.ts`.

- A **std module** is a lower-case top-level `packages/std/src/<name>.ts`. `std/<name>`
  resolves to it through a `paths` entry on the program's own compiler options, so the
  checker, the gate and the module graph all resolve it the same way.
- `std/sync` and `std/thread` are **not-yet** (`STA1214`, Phase 10, T10.2: OS threads).
- **Any other `std/…`** is a hard error, `STA3002`, listing the std modules — never a
  fall-through to a package lookup. That includes the library's own plumbing
  (`std/internal/error`, `std/native/env`): only top-level modules are importable.
- The std root is the sibling workspace package (`packages/std`), or `STATOR_STD_ROOT` when
  set.

Nothing about `std` depends on the mode: a `js`-mode program imports the same typed modules,
and its untyped arguments cross the boundary checks the typed signatures imply. Below the
frontend nothing knows a file came from `std`, except the link (§6).

## 2. Sync vs Promise APIs

v0 ships **sync only**. Promise-flavored `std/fs` arrives with T10.2 as thin `async` wrappers
that `await` a thread-pool job (Design B). Until then there is no sync-under-`async` lie that
blocks main by accident (T10.1 step 5).

The twins are named now, so a program that reaches for one hears when it lands rather than that
it does not exist. Each sync call's twin is its name plus `Async`, answering a `Promise`:
`readTextAsync`, `writeTextAsync`, `statAsync`, `mkdirAsync`, `unlinkAsync`, `rmdirAsync`.
Importing one is **not-yet** (`STA1214`, Phase 10, T10.2), in both modes. Any other name `std/fs`
does not export is the checker's ordinary error (`STA0012`). The list lives beside the module
list in `packages/compiler/src/frontend/std.ts`.

## 3. Error model

`std` never answers failure silently: no `-1` returns, no `null` where an error belongs. A
failing call **throws an `Error`** whose message is

```
std/<module>.<function>(<argument>): <CODE>
```

for example `std/fs.readText('/tmp/x/missing.txt'): ENOENT`. A string argument is quoted
with single quotes, a number is printed as JavaScript prints it, and `std/env.set` names
only the variable, never the value (it may be a secret).

`<CODE>` is a POSIX errno name from this closed vocabulary. It maps the backing's Zig error
(`packages/std/zig/jsrt_std.zig` `failWith`) or, for a backing that calls libc directly, its
errno (`failErrno`), and once listed a code is never renamed:

| Code | Meaning (Zig error) |
|---|---|
| `ENOENT` | no such file or directory (`FileNotFound`) |
| `EACCES` | permission denied (`AccessDenied`, `PermissionDenied`) |
| `EEXIST` | the path already exists (`PathAlreadyExists`) |
| `ENOTDIR` | a path component is not a directory (`NotDir`) |
| `EISDIR` | the path is a directory (`IsDir`) |
| `ENOTEMPTY` | the directory is not empty (`DirNotEmpty`) |
| `ENAMETOOLONG` | the path is too long (`NameTooLong`) |
| `ELOOP` | too many symbolic links (`SymLinkLoop`) |
| `ENOSPC` | no space left on the device (`NoSpaceLeft`) |
| `EROFS` | read-only file system (`ReadOnlyFileSystem`) |
| `EBUSY` | the file or device is busy (`FileBusy`, `DeviceBusy`) |
| `ENOMEM` | out of memory or system resources (`OutOfMemory`, `SystemResources`) |
| `EINVAL` | an invalid argument: a bad path, an empty or `=`-holding variable name, an exit code outside `0..255`, a sleep outside `0..2^31-1` ms (`BadPathName`, or checked before the call) |
| `EFBIG` | the file is too large (`FileTooBig`, `StreamTooLong`) |
| `EBADF` | the descriptor names no open file, or is not an integer in `0..2^31-1` (`std/fs` descriptor calls, `std/io`) |
| `ENOTTY` | the descriptor is not a terminal (`std/io.terminalSize`) |
| `EAGAIN` | a non-blocking descriptor has nothing to give or no room to take (`std/io`) |
| `EPIPE` | the reading end of the pipe is closed (`std/io` writes) |
| `EIO` | any other failure — never a guess at a closer code |

**v0 carries the code in the message only.** The plan is an `Error` with a `code` property,
but a `class StdError extends Error` does not compile yet (Phase 5's class work), so v0 throws
a plain `Error` and the code is the message's tail. When subclassing `Error` lands, the
thrown value gains `code` with these same strings; the message stays as it is.

## 4. Platforms

POSIX first. The backings use Zig's `std.Io`, so most of them are not POSIX-specific, but CI
builds the archive only on the Unix runtime jobs, like the runtime itself. Where the OS answers
differ, `std` answers one way and says so (§5).

## 5. v0 modules

| Module | v0 surface | Notes |
|---|---|---|
| `std/env` | `has(name): boolean`, `get(name): string \| undefined`, `set(name, value)`, `unset(name)`, `cwd(): string`, `names(): string[]` | `setenv`/`unsetenv` semantics: an empty name or one containing `=` is `EINVAL`; unsetting an unset name succeeds. `names` walks libc `environ` (names only — a value may be a secret). `args` moved to T11.3 as `std/process.argv` (plan-notes 294) |
| `std/process` | `argv(): string[]`, `execPath()`, `platform()`, `arch()`, `pid()`, `ppid()`, `hrtimeNs()`, `memoryUsage(): MemoryUsage`, `exitCode()`, `setExitCode(code)`, `exit(code)`, `abort()` | `exit` takes an integer `0..255` (else `EINVAL`, and nothing exits) and runs libc `exit`, so buffered output is flushed. `abort` raises `SIGABRT`. No signals yet (see below) |
| `std/path` | `isAbsolute`, `basename`, `dirname`, `join(a, b)` | pure TypeScript, no backing (see below) |
| `std/fs` | `readText(path)`, `writeText(path, text)`, `readBytes(path): Uint8Array`, `stat(path): Stat`, `exists(path)`, `realpath(path)`, `utimes(path, atimeMs, mtimeMs)`, `readdir(path): string[]`, `mkdir(path)`, `unlink(path)`, `rmdir(path)`; on descriptors `open(path, flags)`, `read(fd, length, position)`, `write(fd, data, position)`, `close(fd)` | sync (see below); the `…Async` Promise twins are not-yet, T10.2 (§2) |
| `std/time` | `nowMs(): number`, `sleepMs(ms)` | `nowMs` is whole milliseconds since the Unix epoch (`Date.now()`); `sleepMs` blocks the only thread on the monotonic clock, fractions truncated |
| `std/os` | `platform()`, `arch()`, `release()`, `hostname()`, `homedir()`, `tmpdir()`, `cpuCount()`, `totalMemory()`, `eol` | the pinned Node's `node:os` answers (see below) |
| `std/io` | `stdin`/`stdout`/`stderr` (`0`/`1`/`2`), `write(fd, text)`, `writeBytes(fd, bytes)`, `read(fd, max): Uint8Array`, `isatty(fd)`, `terminalSize(fd): TerminalSize` | raw descriptors through libc (see below) |
| `std/encoding` | `utf8ToBytes`/`bytesToUtf8`, `latin1ToBytes`/`bytesToLatin1`, `base64ToBytes`/`bytesToBase64`, `base64urlToBytes`/`bytesToBase64url`, `hexToBytes`/`bytesToHex` | Node's `Buffer` conversions (see below) |
| `std/hash` | `sha256(data)`, `sha1(data)`, `md5(data)` over `Uint8Array \| string`, `randomBytes(size)` | digests as `Uint8Array`; text hashes as its UTF-8 |
| `std/sync` | — | not-yet, T10.2 |
| `std/thread` | — | not-yet, T10.2 |

**`std/path` semantics** are POSIX `basename(3)`/`dirname(3)`, not Node's `path.posix`:
trailing slashes are ignored (`/a/b/` names `b`), the root names itself (`basename('/')` is
`/`, where Node answers `''`), runs of slashes before the last segment collapse
(`dirname('a//b')` is `a`), and nothing is normalized — `.` and `..` are ordinary segments.
`join` takes exactly two segments: an absolute second segment is the answer by itself,
otherwise the two meet at exactly one `/`.

**`std/fs` semantics.** Paths are absolute or relative to the working directory, resolved by
the OS; nothing is normalized. Text is UTF-8 both ways: an invalid byte sequence read back
becomes U+FFFD, and a NUL byte ends the text, because text crosses the C-string boundary
(docs/FFI.md §3); `readBytes` carries every byte. `stat` follows symbolic links and
answers a `Stat` with `size`, `isFile`, `isDirectory` and `mtimeMs` (whole milliseconds).
`Stat` is a class rather than an interface because a class instance has a fixed layout and
compiles static (an interface-typed object literal is a dynamic object); programs get one from
`stat`, never from `new`. `mkdir` creates one directory (its parent must exist), `rmdir`
removes only an empty one (`ENOTEMPTY` otherwise), and `unlink` removes a non-directory —
unlinking a directory is `EISDIR` on every platform (macOS's own answer is `EPERM`, which is
what Node reports there). `unlink` and `rmdir` were planned for T11.3 and landed here, because
a test that creates files has to remove them. `exists` follows symbolic links and answers
`false`, never an error, for anything it cannot reach (Node's `existsSync`). `realpath` is
`realpath(3)`; the path must exist. `utimes` takes milliseconds since the Unix epoch (Node's
`utimesSync` takes seconds), and a time outside a `Date`'s range is `EINVAL`. `readdir` answers
the entry names without `.` and `..`, in byte order, as libuv sorts them for Node.

**`std/fs` descriptors.** `open` answers a descriptor the program owns until it calls `close`:
nothing closes one for it, and closing one twice is `EBADF` (§9.3). `flags` is one of Node's
flag strings: `'r'`, `'r+'`, `'w'`, `'w+'`, `'a'`, `'a+'` and the synchronous (`s`) and
exclusive (`x`) variants Node accepts, in either order (`'rs+'`, `'wx'`, `'xa+'`, …); any other
is `EINVAL`, and a created file gets mode `0666` before the umask. `read` is
one read of at most `length` bytes, and at most 1 MiB, like `std/io.read`; `write` writes all of
`data` and answers its length. Both take a `position`: `-1` (the default) uses and advances the
descriptor's own offset, and any other value is a byte offset (`pread`/`pwrite`), an integer in
`0..2^53`, else `EINVAL`. Descriptors are the same integers `std/io` takes.

**`std/process` semantics** follow the pinned Node's `process`, minus the `node` binary.
`argv()` is `main`'s argument vector exactly: `argv()[0]` is the program as it was invoked,
where Node's `process.argv` puts `node` and then the script. `execPath` is the running
executable's absolute path with symbolic links resolved (libuv's `uv_exepath`). `platform` and
`arch` are `std/os`'s. `hrtimeNs` is the monotonic clock in nanoseconds from an arbitrary origin
(`process.hrtime.bigint()` as a number: exact below 2^53 ns). `memoryUsage()` answers a
`MemoryUsage` with `rss`, the resident set size in bytes (libuv's `uv_resident_set_memory`), a
class like `Stat`. `exitCode()` is the status a normal end returns, 0 until `setExitCode`
changes it; `setExitCode` takes an integer `0..255` (else `EINVAL`, and nothing changes), and
`exit(code)` or an uncaught exception (status 1) still win.

**`std/os` semantics** are the pinned Node's, because `packages/node` builds `node:os` on
them. `platform` and `arch` are spelled as `process.platform`/`process.arch` and fixed at build
time. `release` is `uname(2)`'s release (on macOS the Darwin kernel version). `homedir` is
`$HOME` whenever it is set, even to the empty string, else the password database's entry
(libuv's `uv_os_homedir`). `tmpdir` is the first non-empty of `$TMPDIR`, `$TMP`, `$TEMP`, else
`/tmp`, minus one trailing `/` unless the path is `/`. `cpuCount` is
`os.availableParallelism()`: the CPUs this process may run on (the affinity mask on Linux),
and 1 when the OS will not say. `totalMemory` is physical memory in bytes. `eol` is `'\n'`.

**`std/io` semantics.** Descriptors are integers in `0..2^31-1`; anything else is `EBADF`
(Node's own range check throws a `RangeError` instead, and `isatty` answers `false`). `write`
and `writeBytes` write everything, retrying short writes and `EINTR`, and flush C stdio first,
so `console.log` and a write to the same stream keep program order. `write` takes text as UTF-8
and stops at a NUL (the C-string boundary); `writeBytes` carries any byte. `read` is one
`read(2)` of at most `max` bytes, and at most 1 MiB, because the buffer is allocated before the
call; an empty answer is end of file, and `max` outside `0..2^31-1` is `EINVAL`.
`terminalSize` answers a `TerminalSize` (`columns`, `rows`), a class like `Stat`; a descriptor
that is not a terminal is `ENOTTY`, and one that names no open file is `EBADF`.

**`std/encoding` semantics** are Node's `Buffer`, because `packages/node` builds `Buffer` on
them, and nothing throws. `utf8ToBytes` encodes a lone surrogate as U+FFFD (`EF BF BD`).
`bytesToUtf8` turns each maximal invalid subsequence into one U+FFFD. `latin1ToBytes` keeps
each UTF-16 code unit's low byte. `bytesToBase64` pads with `=`, while `bytesToBase64url` uses
`-`/`_` and no padding. The two base64 decoders are one decoder:
- it reads either alphabet and skips any other character;
- the first `=` ends the input;
- a final group of two or three digits gives one or two bytes, and a single digit gives none.

`hexToBytes` reads digit pairs in either case up to the first pair that is not one, and drops
an odd last digit. Text-to-bytes is plain TypeScript (`charCodeAt`). Bytes-to-text goes
through the backing, because `String.fromCharCode` is not in the subset, so a string can only
be made at the C-string edge. UTF-8 and Latin-1 text therefore crosses in NUL-free runs, with
each `0x00` put back as U+0000.

**`std/hash` semantics.** `sha256`, `sha1` and `md5` return the digest as a fresh `Uint8Array`
(32, 20 and 16 bytes). A string argument is hashed as its UTF-8, as Node's `update(text)`
hashes it. The digests are Zig's `std.crypto`, which ships with the pinned toolchain, so no C
is vendored. SHA-1 and MD5 are there for interop, not security. `randomBytes(size)` reads the
OS's secure source through `std.Io`, and a `size` outside `0..2^31-1` is `EINVAL`.

**Verdicts.** A std module is ordinary strict TypeScript, and `explain` reports its functions
like any other file in the graph: everything is `static` except `std/env.get`, whose
`string | undefined` answer is a union the HIR boxes, and `std/hash`'s digests, whose
`Uint8Array | string` parameter is one. An importer of `std/env` or `std/hash` therefore
explains as `dynamic` (docs/SUBSET.md).

## 6. Implementation layers

```
packages/std/
  src/<module>.ts          the surface users import (strict TS, Stator's own subset)
  src/native/<module>.d.ts its `@statorExtern` declarations (module-form: they export)
  src/native/core.d.ts     `CString` and the shared result/error slots
  src/internal/error.ts    the §3 message builder
  zig/jsrt_std.zig         the root: panic handler, allocator, result + error slots
  zig/<module>.zig         one backing file per module, exporting `jsrt_std_<module>_*`
  justfile                 `just std` → build/libjsrt_std.a
```

- **Extern surface.** Each backing is an ordinary `@statorExtern` function (docs/FFI.md). The
  declarations are module-form `.d.ts` files the surface imports by relative path, so neither
  `CString` nor any binding lands in a user program's global scope.
- **Strings out.** A backing that answers a string parks it in one result slot and returns a
  status; the surface reads it with `jsrtStdResult()`, whose `CString` return the emitter
  copies into a JS string at once (`jsrt_string_from_cstr`). The slot frees the previous answer
  when the next one is parked, so nothing leaks and nothing is read after it is freed.
- **Bytes.** A `Uint8Array` is a row of the extern table (docs/FFI.md §2, plan.md §11c
  T11.3a): the backing receives the view's own bytes and its length (`[*]u8`, `usize`) for the
  call, one call whatever the length, with no copy. Going in, the backing reads the caller's
  view. Coming out, the surface allocates the answer first and the backing fills it in place:
  `std/io.read` and `std/fs.read` size a view (at most 1 MiB), the backing `read(2)`s straight
  into it and returns the count, and only a short read copies, once, into a view of the right
  length. The row is parameter-only, so no backing returns bytes. `std/fs.readBytes` cannot
  size its answer before the read, so it takes two calls: the backing reads the file, parks it
  and answers the count, and the second call copies it into a view of that size and frees it.
- **Process slots.** `argv` and the exit status belong to `main`, so they live in the runtime
  (`packages/runtime/src/jsrt_process.c`), not in this archive. The generated
  `int main(int argc, char **argv)` hands its argument vector to `jsrt_process_args` before any
  module code runs and returns `jsrt_process_exit_code()`; `std/process` binds the slots as
  `@statorExtern` functions.
- **Status and errors.** A backing returns `0` for success and `1` for failure, after storing
  the §3 code where `jsrtStdLastError()` reads it; the surface throws.
- **Panics.** A safety trap in a backing (ReleaseSafe) prints `stator std: internal error:`
  and the message to stderr, then aborts. It is always a bug in `std`.
- **The archive** is built `-O ReleaseSafe`, `-fPIC`, `-mcpu=baseline`, with function and data
  sections, and the macOS deployment target clang uses (the runtime's own Zig rules). It calls
  only libc — never `libjsrt` — so one flavor serves every runtime flavor (plain, ASan, intl).
- **The link.** `cli/build.ts` adds `packages/std/build/libjsrt_std.a` to the link line, before
  `-ljsrt`, only when the program's module graph holds a std source file. A program that
  imports no `std/*` module never names the archive. A missing archive is `STA0011`, naming
  the `just … std` recipe.

Build it with `pnpm run runtime` (which builds the runtime and then the std archive) or
`just -f packages/std/justfile -d packages/std std`. `pnpm run test:asan` and
`pnpm run test:intl` build it too. moon's `std:build` task does the same, and every linking
test task depends on it.

## 7. Testing

- **Goldens** (`packages/tests/golden/ts/std_*.ts`, `js/std_js.js`) import `std/*` exactly as a
  user does. Node, the oracle, loads `golden/std-oracle.ts` first: a resolve hook that maps
  `std/<name>` to a Node-API twin in `golden/std-oracle/<name>.ts`, which must produce the
  same values and the same §3 messages. A module with no backing (`std/path`) maps to the real
  `packages/std/src/<name>.ts`, so the golden proves Stator compiles that source the way Node
  runs it.
- **Decision tests** (`packages/tests/subset/subset_std_*`) cover each module in both modes,
  plus the unknown (`STA3002`), threads (`STA1214`) and Promise-twin (`STA1214`) refusals.
- **Unit tests** (`packages/tests/unit/std.test.ts`) prove the conditional link and what a golden
  cannot run. That covers the two exits (a non-zero `exit`, `abort`), real arguments, a
  non-zero `setExitCode`, ranges for the values that differ every run (`pid`, `ppid`,
  `execPath`, `hrtimeNs`, `memoryUsage`, `randomBytes`), `std/io`'s ordering against
  `console.log`, a real read from stdin, and a terminal (`script(1)` gives the binary a
  pseudo-terminal). The golden runner's stdin is an open pipe and its stdout is never a
  terminal.

## 8. v0 limitations

- **C-string boundary.** `std/fs` text and `std/io.write` stop at a NUL byte, and every string
  argument is passed as UTF-8 (§5). Bytes (`std/io.writeBytes`/`read`, `std/fs.readBytes`/
  `read`/`write`) do not: a `Uint8Array` crosses as its own storage (§6), so any byte, NUL
  included, survives.
- **No `code` property** on thrown errors yet (§3).

## 9. Decisions that were open

1. **Error codes** (§3): POSIX errno names, one closed table for all of `std`, `EIO` for
   anything outside it.
2. **`std/path` edge semantics** (§5): POSIX `basename(3)`/`dirname(3)`, no normalization,
   two-segment `join`; Node's `path.posix` is not the reference.
3. **`std/fs` surface**: path calls since T11.2; descriptors since T11.3. A descriptor is a
   plain integer the program owns from `open` to `close`, with no finalizer: a GC-driven close
   would make the descriptor's lifetime depend on the collector, and a reused number would then
   close someone else's file.
4. **Encoding**: UTF-8 at every native edge. Invalid bytes coming back become U+FFFD, as
   FFI's `from_cstr` already does; nothing throws over encoding.

## 10. What `std` is not

- Not a Node polyfill: `std/fs.readText` does not accept Node's option bags or match its
  error strings — it matches POSIX and documents deltas. `packages/node` (T11.6) builds
  `node:*` on top of `std`, not the other way round.
- Not user FFI: users cannot add `std/*` modules; the prefix is reserved. Native
  extensibility stays Phase 7's `declare` surface.
- Not threads (v0): the T10.2 modules refuse until the bridge exists; the refusal names
  Phase 10, not a workaround.
