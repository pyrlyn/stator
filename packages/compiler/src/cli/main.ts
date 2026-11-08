import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telemetryInit, telemetryShutdown, withSpanAsync } from '../support/telemetry.ts';
import { BuildError, build, internalErrorMessage, type OptLevel } from './build.ts';
import { type BundlerChoice, bundlerChoice, DEFAULT_BUNDLER } from './bundler.ts';
import type { CcChoice } from './cc.ts';
import {
  type CliOptions,
  type ConfigChoice,
  loadConfig,
  resolveOptions,
  splitFlags,
} from './config.ts';
import { applyEnvFile, envFileNotice } from './env-file.ts';
import { explain } from './explain.ts';
import { INK_COLORS, print } from './render.ts';

type Mode = 'ts' | 'js';

type Command =
  | { kind: 'help'; command: 'top' | 'build' | 'explain' }
  | { kind: 'version' }
  | {
      kind: 'build';
      entry: string;
      out: string;
      mode: Mode;
      emitC: boolean;
      emitLib: boolean;
      keepC: boolean;
      opt: OptLevel;
      linkFlags: readonly string[];
      emitHeader: string | undefined;
      unitName: string | undefined;
      bundler: BundlerChoice;
      cc: CcChoice | undefined;
      node: boolean;
    }
  | {
      kind: 'explain';
      entry: string;
      mode: Mode;
      json: boolean;
      bundler: BundlerChoice;
      node: boolean;
    };

const USAGE = `stator — ahead-of-time compiler for TypeScript/JavaScript

Usage:
  stator build <entry> -o <out> [--mode=ts|js] [--node] [--emit=c|lib] [--keep-c]
    [--opt=0|1|2|3] [--link=<flags>]... [--emit-header=<h> [--unit-name=<unit>]]
    [--bundler=vite|none|<module>] [--cc=<name|path>]
  stator explain <entry> [--mode=ts|js] [--node] [--json] [--bundler=vite|none|<module>]
  stator <command> --help
  stator --version
  stator --help

Modes:
  ts  (default)  strict static TypeScript; .ts only; explicit any is an error
  js             JavaScript, or JS + TS mixed; untyped code goes dynamic

Platform:
  --node         node:* and bare built-ins resolve to packages/node

Config:
  Every option can also come from ./stator.config.json (docs/CONFIG.md);
  the command line wins. --config=<path> reads another file, --no-config
  reads none.
`;

/** Per-command help, after oclif's convention: `<command> --help` documents that command's flags,
 * not the whole CLI. Lines stay under 76 columns: ink wraps at the terminal width, so a help line
 * that fits the fallback width reads the same on a TTY and on a pipe (plan-notes 187). */
const COMMAND_USAGE = {
  build: `Usage:
  stator build <entry> -o <out> [--mode=ts|js] [--node] [--emit=c|lib] [--keep-c]
    [--opt=0|1|2|3] [--link=<flags>]... [--emit-header=<h> [--unit-name=<unit>]]
    [--bundler=vite|none|<module>] [--cc=<name|path>]

Flags:
  -o, --out <out>  output path: native binary, or C with --emit=c
  --mode ts|js     strict ts (default) or dynamic js; diagnostics only
  --node           the Node platform: node:* and bare built-ins resolve
                   to packages/node (docs/MODES.md §6)
  --emit=c         stop after writing C to <out>; skip the C compiler
  --keep-c         keep the intermediate .c next to the binary
  --opt 0|1|2|3    clang -O level (default 2; or STATOR_OPT)
  --link <flags>   extra clang link flags (repeatable; splits on spaces);
                   joins the @statorLink pragma flags (docs/FFI.md)
  --emit-header <h> write a C header for the unit's exports (docs/FFI.md);
                   -o names a relocatable object, not an executable
  --emit=lib       with --emit-header: -o lib<name>.a is a static library
                   with a private runtime, plus lib<name>.pc beside it
  --unit-name <unit> prefix for stator_<unit>_<name> (default: entry basename)
  --bundler <b>    js mode: bundles package imports and CommonJS files;
                   vite (default), none, or an adapter module (BUNDLER.md)
  --emit=binary    build a binary (default; overrides "emit": "c" or "lib")
  --cc <cc>        C compiler: clang, Apple clang or gcc, by name or path
                   (default clang; or config "cc", then CC)
  --config <path>  read options from this JSON file (default:
                   ./stator.config.json when it exists; docs/CONFIG.md)
  --no-config      ignore stator.config.json
`,
  explain: `Usage:
  stator explain <entry> [--mode=ts|js] [--node] [--json] [--bundler=<b>]

Reports the file verdict: static | dynamic | error | not-yet, with the
STA code and every diagnostic that decided it, then the static/dynamic
split per function. A rejected program still exits 0 — the verdict is
the answer, so a refusal is a result, not a crash.

Flags:
  --mode ts|js     strict ts (default) or dynamic js
  --node           the Node platform; a built-in packages/node has not
                   landed is not-yet, naming T11.6
  --json           machine-readable report (used by the decision tests);
                   --diagnostics=text|json spells the same choice
  --bundler <b>    js mode: vite (default), none, or an adapter module
  --config <path>  read options from this JSON file (default:
                   ./stator.config.json when it exists; docs/CONFIG.md)
  --no-config      ignore stator.config.json
`,
} as const;

/** User-facing failure. Carries a stable STA code; never a raw stack trace (AGENTS.md). */
class StatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'StatorError';
  }
}

function readVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return parsed.version;
  }
  throw new StatorError('STA4001', 'package.json has no readable "version" field');
}

function parseMode(raw: string): Mode {
  if (raw === 'ts' || raw === 'js') {
    return raw;
  }
  throw new StatorError('STA0002', `unknown mode "${raw}" (expected "ts" or "js")`);
}

/** `origin` names where the value came from when it is not the flag itself, so a bad
 * `STATOR_OPT` points at the environment rather than at a command line that has no `--opt`. */
function parseOpt(raw: string, origin = ''): OptLevel {
  if (raw === '0' || raw === '1' || raw === '2' || raw === '3') {
    return Number(raw) as OptLevel;
  }
  throw new StatorError('STA0002', `unknown opt "${raw}"${origin} (expected 0, 1, 2, or 3)`);
}

/** `STATOR_OPT`, below `--opt` and above the config file (Task 6.18 step 3). */
function envOpt(): OptLevel | undefined {
  const env = process.env['STATOR_OPT'];
  if (env === undefined || env === '') {
    return undefined;
  }
  return parseOpt(env, ' in the environment variable STATOR_OPT');
}

/** One `--link` value into clang flags: whitespace-separated, so `--link="-lsqlite3 -L/x"`
 * and two `--link` occurrences spell the same line. Empty is a user error, not an empty flag:
 * it almost always means an unexpanded `$VAR`, and an invisible no-op would hide that. */
function splitLinkFlags(raw: string): string[] {
  const flags = splitFlags(raw);
  if (flags.length === 0) {
    throw new StatorError('STA0004', '--link requires a value (clang link flags)');
  }
  return flags;
}

type CommandName = 'build' | 'explain';

interface ParseState {
  readonly cli: CliOptions;
  readonly linkFlags: string[];
  configChoice: ConfigChoice;
}

/** One flag: the commands it belongs to, and for a value flag what the value is (the tail of
 * its "requires" message) and whether `--flag=value` spells it too. A flag outside its command
 * is refused, not ignored: an inert flag hides a typo in a script (plan.md §9 Task 6.20). */
interface FlagSpec {
  readonly commands: readonly CommandName[];
  readonly value?: { readonly what: string; readonly equals: boolean };
  readonly apply: (state: ParseState, value: string) => void;
}

const BOTH: readonly CommandName[] = ['build', 'explain'];
const BUILD: readonly CommandName[] = ['build'];
const EXPLAIN: readonly CommandName[] = ['explain'];

const OUT: FlagSpec = {
  commands: BUILD,
  value: { what: 'an output path', equals: false },
  apply: (s, v) => {
    s.cli.out = v;
  },
};
const JSON_REPORT: FlagSpec = {
  commands: EXPLAIN,
  apply: (s) => {
    s.cli.diagnostics = 'json';
  },
};

const FLAGS: Readonly<Record<string, FlagSpec>> = {
  '-o': OUT,
  '--out': OUT,
  '--mode': {
    commands: BOTH,
    value: { what: 'a value (ts or js)', equals: true },
    apply: (s, v) => {
      s.cli.mode = parseMode(v);
    },
  },
  '--opt': {
    commands: BUILD,
    value: { what: 'a value (0, 1, 2, or 3)', equals: true },
    apply: (s, v) => {
      s.cli.opt = parseOpt(v);
    },
  },
  '--link': {
    commands: BUILD,
    value: { what: 'a value (clang link flags)', equals: true },
    apply: (s, v) => {
      s.linkFlags.push(...splitLinkFlags(v));
    },
  },
  '--emit-header': {
    commands: BUILD,
    value: { what: 'a value (output header path)', equals: true },
    apply: (s, v) => {
      s.cli.emitHeader = v;
    },
  },
  '--unit-name': {
    commands: BUILD,
    value: { what: 'a value (C identifier prefix)', equals: true },
    apply: (s, v) => {
      s.cli.unitName = v;
    },
  },
  '--cc': {
    commands: BUILD,
    value: { what: 'a value (C compiler name or path)', equals: true },
    apply: (s, v) => {
      s.cli.cc = v;
    },
  },
  '--bundler': {
    commands: BOTH,
    value: { what: 'a value (vite, none or a module)', equals: true },
    apply: (s, v) => {
      s.cli.bundler = v;
    },
  },
  '--config': {
    commands: BOTH,
    value: { what: 'a value (config file path)', equals: true },
    apply: (s, v) => {
      s.configChoice = { kind: 'path', path: v };
    },
  },
  '--no-config': {
    commands: BOTH,
    apply: (s) => {
      s.configChoice = { kind: 'none' };
    },
  },
  '--json': JSON_REPORT,
  '--diagnostics=json': JSON_REPORT,
  '--diagnostics=text': {
    commands: EXPLAIN,
    apply: (s) => {
      s.cli.diagnostics = 'text';
    },
  },
  '--emit=c': {
    commands: BUILD,
    apply: (s) => {
      s.cli.emit = 'c';
    },
  },
  '--emit=lib': {
    commands: BUILD,
    apply: (s) => {
      s.cli.emit = 'lib';
    },
  },
  '--emit=binary': {
    commands: BUILD,
    apply: (s) => {
      s.cli.emit = 'binary';
    },
  },
  '--keep-c': {
    commands: BUILD,
    apply: (s) => {
      s.cli.keepC = true;
    },
  },
  '--node': {
    commands: BOTH,
    apply: (s) => {
      s.cli.node = true;
    },
  },
};

/** The flag `arg` spells, and its inline `=value` when it has one. */
function lookupFlag(arg: string): { name: string; spec: FlagSpec; inline?: string } | undefined {
  const exact = FLAGS[arg];
  if (exact !== undefined) {
    return { name: arg, spec: exact };
  }
  const eq = arg.indexOf('=');
  if (!arg.startsWith('--') || eq < 0) {
    return undefined;
  }
  const name = arg.slice(0, eq);
  const spec = FLAGS[name];
  return spec?.value?.equals === true ? { name, spec, inline: arg.slice(eq + 1) } : undefined;
}

/** A value flag's value. The next argument is refused when it looks like a flag: `-o --emit=c`
 * is a forgotten path, not a file named `--emit=c`. A value that really starts with `-` (a
 * clang flag for `--link`) has the `--flag=value` spelling. */
function flagValue(
  name: string,
  value: { what: string; equals: boolean },
  inline: string | undefined,
  next: string | undefined,
): string {
  const given = inline ?? next;
  if (given === undefined || given === '') {
    throw new StatorError('STA0004', `${name} requires ${value.what}`);
  }
  if (inline === undefined && given.startsWith('-')) {
    const hint = value.equals ? ` (write ${name}=${given} if that is the value)` : '';
    throw new StatorError(
      'STA0004',
      `${name} requires ${value.what}, not the flag "${given}"${hint}`,
    );
  }
  return given;
}

function parse(argv: readonly string[]): Command {
  const head = argv[0];
  if (head === undefined || head === '--help' || head === '-h') {
    return { kind: 'help', command: 'top' };
  }
  if (head === '--version' || head === '-v') {
    return { kind: 'version' };
  }
  if (head !== 'build' && head !== 'explain') {
    throw new StatorError('STA0003', `unknown command "${head}" (expected "build" or "explain")`);
  }

  const state: ParseState = {
    cli: {
      entry: undefined,
      out: undefined,
      mode: undefined,
      opt: undefined,
      link: [],
      emit: undefined,
      keepC: undefined,
      emitHeader: undefined,
      unitName: undefined,
      bundler: undefined,
      cc: undefined,
      diagnostics: undefined,
      node: undefined,
    },
    linkFlags: [],
    configChoice: { kind: 'discover' },
  };
  const { cli, linkFlags } = state;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { kind: 'help', command: head };
    }
    const flag = lookupFlag(arg);
    if (flag === undefined) {
      if (arg.startsWith('-')) {
        throw new StatorError('STA0005', `unknown flag "${arg}"`);
      }
      if (cli.entry !== undefined) {
        throw new StatorError('STA0006', `unexpected argument "${arg}"`);
      }
      cli.entry = arg;
      continue;
    }
    if (!flag.spec.commands.includes(head)) {
      throw new StatorError('STA0005', `flag "${arg}" does not apply to ${head}`);
    }
    let value = '';
    if (flag.spec.value !== undefined) {
      value = flagValue(flag.name, flag.spec.value, flag.inline, argv[i + 1]);
      if (flag.inline === undefined) {
        i += 1;
      }
    }
    flag.spec.apply(state, value);
  }

  // Read after the scan, so `--help` and an unknown flag never touch the file.
  const options = resolveOptions(
    { ...cli, link: linkFlags },
    { opt: envOpt() },
    loadConfig(state.configChoice, process.cwd()),
  );
  const { entry, out, mode } = options;
  if (entry === undefined) {
    throw new StatorError('STA0004', `"${head}" requires an entry file`);
  }
  // A ts-mode graph never bundles (docs/BUNDLER.md §5): a package import there is refused at the
  // gate, so a bundler choice is a mistake worth naming, not an inert flag.
  if (mode === 'ts' && options.bundler !== undefined) {
    throw new StatorError('STA0004', '--bundler requires --mode=js');
  }
  const bundler = options.bundler === undefined ? DEFAULT_BUNDLER : bundlerChoice(options.bundler);
  if (head === 'build') {
    if (out === undefined) {
      throw new StatorError('STA0004', 'build requires -o <out>');
    }
    return {
      kind: 'build',
      entry,
      out,
      mode,
      emitC: options.emit === 'c',
      emitLib: options.emit === 'lib',
      keepC: options.keepC,
      opt: options.opt,
      linkFlags: options.link,
      emitHeader: options.emitHeader,
      unitName: options.unitName,
      bundler,
      cc: options.cc,
      node: options.node,
    };
  }
  return {
    kind: 'explain',
    entry,
    mode,
    json: options.diagnostics === 'json',
    bundler,
    node: options.node,
  };
}

async function run(command: Command): Promise<void> {
  const spanName =
    command.kind === 'help' || command.kind === 'version'
      ? `stator --${command.kind}`
      : `stator ${command.kind}`;
  const attrs =
    command.kind === 'build' || command.kind === 'explain'
      ? {
          'stator.mode': command.mode,
          'stator.entry': command.entry,
          'stator.node': String(command.node),
        }
      : {};
  await withSpanAsync(spanName, attrs, () => runCommand(command));
}

async function runCommand(command: Command): Promise<void> {
  switch (command.kind) {
    case 'help': {
      const usage = command.command === 'top' ? USAGE : COMMAND_USAGE[command.command];
      // `usage` ends with '\n' — the CLI's trailing-newline contract — but `print` adds its own,
      // so hand ink the text without it rather than double-space the end of help.
      await print([{ text: usage.trimEnd() }], process.stdout);
      return;
    }
    case 'version':
      await print([{ text: readVersion() }], process.stdout);
      return;
    case 'build':
      process.exitCode = await build({
        entry: command.entry,
        out: command.out,
        mode: command.mode,
        emitCOnly: command.emitC,
        emitLib: command.emitLib,
        keepC: command.keepC,
        opt: command.opt,
        linkFlags: command.linkFlags,
        bundler: command.bundler,
        ...(command.emitHeader !== undefined && { emitHeader: command.emitHeader }),
        ...(command.unitName !== undefined && { unitName: command.unitName }),
        ...(command.cc !== undefined && { cc: command.cc }),
        node: command.node,
      });
      return;
    case 'explain':
      process.exitCode = await explain(
        command.entry,
        command.mode,
        command.json,
        command.bundler,
        command.node,
      );
      return;
  }
}

async function main(): Promise<void> {
  // .env before anything reads the environment (STATOR_OTEL, STATOR_OPT, STATOR_RUNTIME), and
  // only those keys: the file belongs to the project being compiled, not to the user running
  // Stator (src/cli/env-file.ts). A real variable is never overridden. The notice goes to
  // stderr, outside the byte-exact stdout contract.
  const notice = envFileNotice(applyEnvFile(process.cwd(), process.env));
  if (notice !== undefined) {
    process.stderr.write(`${notice}\n`);
  }
  await telemetryInit();
  try {
    await run(parse(process.argv.slice(2)));
  } catch (error) {
    // Two error types, one rendering: BuildError is raised below the CLI layer but carries the
    // same contract -- a stable code and a message the user can act on (AGENTS.md).
    if (error instanceof StatorError || error instanceof BuildError) {
      await print(
        [{ text: `stator: ${error.code} ${error.message}`, color: INK_COLORS.error }],
        process.stderr,
      );
      process.exitCode = 1;
      return;
    }
    // Everything else is a compiler bug, and the contract for one is a diagnostic -- never a raw
    // Node stack trace (AGENTS.md: "A thrown exception reaching the CLI is a compiler bug"). The
    // TypeScript checker's own stack overflow does not land here: `createProgram` names it STA0013,
    // because plain `tsc` dies on the same input (plan-notes 287). Naming the crash is the honest
    // answer, and the message asks for the input so the next step can be a real fix.
    await print(
      [
        {
          text: `stator: STA4072 ${internalErrorMessage(error)}`,
          color: INK_COLORS.error,
        },
      ],
      process.stderr,
    );
    process.exitCode = 1;
  } finally {
    await telemetryShutdown();
  }
}

await main();
