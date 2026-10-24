# CONFIG.md — `stator.config.json`

Every option `stator build` and `stator explain` take can come from a JSON file, from the command
line, or from both (plan.md §9 Task 6.18, plan-notes 303). Stator works the same without a file:
flags and built-in defaults, exactly as before.

## Discovery

| Command line | File read |
| --- | --- |
| *(nothing)* | `./stator.config.json` in the **current directory**, if it exists. No file is not an error. Parent directories are never searched: a parent project's file must not change a build silently |
| `--config=<path>` or `--config <path>` | that file, relative to the current directory. A missing file is `STA0018` |
| `--no-config` | none, even if `./stator.config.json` exists |

The last of `--config` / `--no-config` on a command line wins. These two flags, `--help` and
`--version` are the only ones with **no** key in the file: a config cannot name a config.

The file is strict JSON: no comments, no trailing commas. It is read only after the command line
is scanned, so `--help` and an unknown flag never touch it.

## Keys

One key per flag. The schema is generated from `packages/compiler/src/cli/config.ts` into
[`packages/compiler/schema/stator.config.schema.json`](../packages/compiler/schema/stator.config.schema.json)
(`pnpm run schema:config`); a unit test fails if the committed file drifts.

| Key | Type | Flag | Default | Used by |
| --- | --- | --- | --- | --- |
| `$schema` | string | — | — | editors only; ignored by Stator |
| `entry` | path | positional `<entry>` | — (required somewhere) | both |
| `out` | path | `-o`, `--out` | — (required for `build`) | `build` |
| `mode` | `"ts"` \| `"js"` | `--mode` | `"ts"` | both |
| `opt` | `0` \| `1` \| `2` \| `3` | `--opt` (env `STATOR_OPT`) | `2` | `build` |
| `link` | array of strings | `--link` (repeatable) | `[]` | `build` |
| `emit` | `"binary"` \| `"c"` \| `"lib"` | `--emit=binary`, `--emit=c`, `--emit=lib` | `"binary"` | `build` |
| `keepC` | boolean | `--keep-c` | `false` | `build` |
| `emitHeader` | path | `--emit-header` | — | `build` |
| `unitName` | string, letters, digits and `_` only (else `STA0004`) | `--unit-name` | entry basename, sanitized | `build` |
| `bundler` | `"vite"` \| `"none"` \| module | `--bundler` | `"vite"` | both, `js` mode only (`STA0004` in `ts` mode) |
| `diagnostics` | `"text"` \| `"json"` | `--json`, `--diagnostics=text\|json` | `"text"` | `explain` |
| `node` | boolean | `--node` | `false` | both |

A key a command does not use is ignored by that command, so one file serves both. A **flag** is
not: on the command line, a flag that belongs to the other command is `STA0005` (`explain
--emit=c`, `build --json`), because an inert flag hides a typo in a script (plan.md §9 Task 6.20).
A value flag never takes a next argument that starts with `-`: `-o --emit=c` is `STA0004`. A
value that really starts with `-` uses the `--flag=value` spelling (`--link=-lm`); `-o` has no
such spelling, so an output path cannot start with `-` (write `./-name`).

## Outputs

`build` refuses (`STA0004`) any two of the entry, every source file of the program, `-o`,
`--emit-header` and the `--keep-c` file (`<out>.c`) that name the same file, before anything is
written, whether those paths came from flags or from this file. An output the file system will
not take (a missing directory, no permission, a read-only or full disk, `-o` naming a directory)
is `STA0019`, never the compiler-bug `STA4072` (docs/DIAGNOSTICS.md).

**Paths** (`entry`, `out`, `emitHeader`, and a `bundler` module that starts with `.`) in the file resolve against the **file's directory**;
paths on the command line resolve against the current directory. Each `link` entry splits on
whitespace like one `--link` value; `-L` paths inside it are passed to clang as written.

Planned flags get their keys in the same change as the flag: `renderer` (T13), `interpreter`
(T14); `bundler` landed with T12.1 and `node` with `--node` (T11.5). Like `keepC`, `node: true`
has no command-line negation: `--no-config` is how a build turns it off. Every new flag lands with
its key and a regenerated schema
(AGENTS.md).

## Precedence

Highest first:

1. the command line;
2. the environment (`STATOR_OPT` for `opt`), which a project `.env` may fill in for
   `STATOR_OPT`, `STATOR_RUNTIME` and `STATOR_OTEL` only; never `CC`, `STATOR_RUNTIME_ROOT`,
   `OTEL_*`, `STATOR_COMPILE_JOBS` or `STATOR_COMPILE_TIMING` (docs/TOOLCHAIN.md, "Environment
   variables and `.env`"). `STATOR_COMPILE_JOBS` has no flag and no config key: it is only the
   host environment;
3. the config file;
4. the built-in default.

`link` is the exception: the file's flags and the command line's are **concatenated**, file
first, so a project's libraries stay linked when a run adds one more.

## Example

```json
{
  "$schema": "./node_modules/statorc/schema/stator.config.schema.json",
  "entry": "src/main.ts",
  "out": "build/app",
  "mode": "js",
  "opt": 3,
  "link": ["-lsqlite3"]
}
```

With that file in the current directory:

```sh
stator build                     # src/main.ts -> build/app, js mode, -O3, -lsqlite3
stator build --opt=0 --link=-lz  # same, -O0, -lsqlite3 -lz
stator explain --mode=ts         # src/main.ts in ts mode
stator build x.ts -o x --no-config
```

`$schema` points editors at the schema; inside this repository use
`./packages/compiler/schema/stator.config.schema.json`.

## Errors

| Code | When |
| --- | --- |
| `STA0016` | The file cannot be read, or is not valid JSON. The message names `path:line:column` |
| `STA0017` | The file does not match the schema. Every violation is listed with its JSON pointer and what was expected, e.g. `/mode: expected one of "ts", "js"`; an unknown key is `/mdoe: unknown key` |
| `STA0018` | `--config` names a missing file |

Full rows: [DIAGNOSTICS.md](DIAGNOSTICS.md).
