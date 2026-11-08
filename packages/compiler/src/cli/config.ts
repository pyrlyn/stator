/* `stator.config.json`: the one module that finds, loads and validates the CLI's config file
 * (plan.md §9 Task 6.18, plan-notes 303; AGENTS.md, Config files). The schema below is the single
 * source of truth: the `Config` type is derived from it, and the committed JSON Schema at
 * `packages/compiler/schema/stator.config.schema.json` is generated from it
 * (`pnpm run schema:config`) and checked for drift by `packages/tests/unit/config.test.ts`.
 *
 * Every failure is a `BuildError` with a stable STA code, never a stack trace:
 * STA0016 (unreadable or not JSON), STA0017 (does not match the schema), STA0018 (`--config`
 * names a missing file). */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { BuildError } from '../support/diagnostics.ts';
import type { OptLevel } from './build.ts';
import type { CcChoice } from './cc.ts';
import { errnoCode } from './outputs.ts';

export const CONFIG_FILE_NAME = 'stator.config.json';

const nonEmpty = (description: string) => Type.String({ minLength: 1, description });

/** One key per CLI flag (Task 6.18 step 2). `--config`, `--no-config`, `--help` and `--version`
 * have no key: a config cannot name a config. A new flag lands with its key here, in the same
 * change, and the schema is regenerated (AGENTS.md). */
export const ConfigSchema = Type.Object(
  {
    $schema: Type.Optional(
      Type.String({ description: 'Path or URL of this JSON Schema, for editors. Ignored.' }),
    ),
    entry: Type.Optional(
      nonEmpty('Entry file; relative to this file. The positional <entry> overrides it.'),
    ),
    out: Type.Optional(
      nonEmpty('build: output path, relative to this file. -o/--out overrides it.'),
    ),
    mode: Type.Optional(
      Type.Enum(['ts', 'js'], {
        description: '--mode: strict ts (default) or dynamic js.',
      }),
    ),
    opt: Type.Optional(
      Type.Enum([0, 1, 2, 3], {
        description: 'build: clang -O level (default 2). --opt and STATOR_OPT override it.',
      }),
    ),
    link: Type.Optional(
      Type.Array(Type.String({ pattern: '\\S' }), {
        description:
          'build: extra clang link flags; each entry splits on spaces like one --link value. ' +
          'Command-line --link flags are appended after these.',
      }),
    ),
    emit: Type.Optional(
      Type.Enum(['binary', 'c', 'lib'], {
        description:
          'build: "c" stops after writing C to out (--emit=c); "lib" writes out as a static ' +
          'library lib<name>.a plus lib<name>.pc, and needs emitHeader (--emit=lib). ' +
          'Default "binary".',
      }),
    ),
    keepC: Type.Optional(
      Type.Boolean({ description: 'build: keep the intermediate .c next to the binary.' }),
    ),
    emitHeader: Type.Optional(
      nonEmpty('build: write a C header for the unit exports; relative to this file.'),
    ),
    unitName: Type.Optional(
      nonEmpty(
        'build: prefix for stator_<unit>_<name>; letters, digits and _ only (else STA0004).',
      ),
    ),
    bundler: Type.Optional(
      nonEmpty(
        'js mode: "vite" (default; the vite-stator package), "none", or an adapter module — a ' +
          'path relative to this file when it starts with ".", else a package name (docs/BUNDLER.md).',
      ),
    ),
    cc: Type.Optional(
      nonEmpty(
        'build: the C compiler, a name on PATH or a path (relative to this file when it starts ' +
          'with "."); clang, Apple clang or gcc. --cc and CC override it ' +
          '(docs/TOOLCHAIN.md, C compiler). Default clang.',
      ),
    ),
    diagnostics: Type.Optional(
      Type.Enum(['text', 'json'], {
        description: 'explain: report format; "json" is --json (default "text").',
      }),
    ),
    node: Type.Optional(
      Type.Boolean({
        description:
          'build and explain: the Node platform (--node). node:* and bare built-ins resolve to ' +
          'packages/node (docs/MODES.md §6). Default false.',
      }),
    ),
  },
  { additionalProperties: false },
);

export type Config = Static<typeof ConfigSchema>;

/** The committed schema document: the TypeBox schema plus the JSON Schema dialect and a title. */
export function configSchemaDocument(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'stator.config.json',
    description:
      'Stator CLI options (docs/CONFIG.md). The command line overrides the environment, which ' +
      'overrides this file, which overrides the built-in defaults.',
    ...ConfigSchema,
  };
}

/** Which file to read: the default discovery, an explicit `--config`, or none (`--no-config`). */
export type ConfigChoice = { kind: 'discover' } | { kind: 'path'; path: string } | { kind: 'none' };

export interface LoadedConfig {
  /** Absolute path of the file that was read. */
  path: string;
  config: Config;
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}

/** Strict JSON: `JSON.parse` decides validity and produces the value. It does not report where it
 * failed for every error (V8 omits the position for an unexpected token), so a failure is
 * located by `jsonc-parser` with comments and trailing commas disallowed. */
function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const errors: ParseError[] = [];
    parseJsonc(text, errors, {
      disallowComments: true,
      allowTrailingComma: false,
      allowEmptyContent: false,
    });
    const first = errors[0];
    const offset = first?.offset ?? 0;
    const reason =
      first === undefined
        ? error instanceof Error
          ? error.message
          : String(error)
        : printParseErrorCode(first.error);
    const { line, column } = lineAndColumn(text, offset);
    throw new BuildError('STA0016', `${path}:${line}:${column}: not valid JSON (${reason})`);
  }
}

function describeError(error: {
  keyword: string;
  instancePath: string;
  params: object;
  message: string;
}): string {
  const at = error.instancePath === '' ? '/' : error.instancePath;
  if (error.keyword === 'additionalProperties' && 'additionalProperties' in error.params) {
    const raw: unknown = error.params.additionalProperties;
    // `unknown[]`, not the `any[]` `Array.isArray` narrows to: Stator compiles this file in `ts`
    // mode (Task 6.19), where an implicit `any` is STA1003.
    const keys: readonly unknown[] = Array.isArray(raw) ? raw : [];
    // One JSON pointer per key (RFC 6901: `~` and `/` escape as `~0` and `~1`).
    return keys
      .map(
        (key) =>
          `${error.instancePath}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}: unknown key`,
      )
      .join('; ');
  }
  if (error.keyword === 'enum' && 'allowedValues' in error.params) {
    const raw: unknown = error.params.allowedValues;
    const allowed: readonly unknown[] = Array.isArray(raw) ? raw : [];
    const list = allowed.map((value) => JSON.stringify(value)).join(', ');
    return `${at}: expected one of ${list}`;
  }
  if (error.keyword === 'pattern') {
    return `${at}: expected a string with a non-space character`;
  }
  return `${at}: ${error.message}`;
}

/** Validate a parsed value against the schema. Exported for the unit tests. */
export function validateConfig(value: unknown, path: string): Config {
  if (Value.Check(ConfigSchema, value)) {
    return value;
  }
  // An unknown key is reported twice by the validator: once as the key's `false` schema and once
  // as `additionalProperties`. The second names the key, so the first is dropped.
  const problems = Value.Errors(ConfigSchema, value)
    .filter((error) => error.keyword !== 'boolean')
    .map(describeError);
  throw new BuildError('STA0017', `${path}: does not match the schema: ${problems.join('; ')}`);
}

/** Find, read and validate the config file. `undefined` when there is none to read. */
export function loadConfig(choice: ConfigChoice, cwd: string): LoadedConfig | undefined {
  if (choice.kind === 'none') {
    return undefined;
  }
  const path = resolve(cwd, choice.kind === 'path' ? choice.path : CONFIG_FILE_NAME);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      if (choice.kind === 'discover') {
        return undefined;
      }
      throw new BuildError('STA0018', `--config names a missing file: ${path}`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new BuildError('STA0016', `${path}: cannot read the config file (${reason})`);
  }
  return { path, config: validateConfig(parseJson(text, path), path) };
}

/** Options as the command line gave them: `undefined` where a flag was absent. */
export interface CliOptions {
  entry: string | undefined;
  out: string | undefined;
  mode: 'ts' | 'js' | undefined;
  opt: OptLevel | undefined;
  link: readonly string[];
  emit: 'binary' | 'c' | 'lib' | undefined;
  keepC: boolean | undefined;
  emitHeader: string | undefined;
  unitName: string | undefined;
  bundler: string | undefined;
  cc: string | undefined;
  diagnostics: 'text' | 'json' | undefined;
  node: boolean | undefined;
}

export interface ResolvedOptions {
  entry: string | undefined;
  out: string | undefined;
  mode: 'ts' | 'js';
  opt: OptLevel;
  link: readonly string[];
  emit: 'binary' | 'c' | 'lib';
  keepC: boolean;
  emitHeader: string | undefined;
  unitName: string | undefined;
  bundler: string | undefined;
  /** `--cc` or config `cc`; `build` puts `CC` between them and applies the default (`cc.ts`). */
  cc: CcChoice | undefined;
  diagnostics: 'text' | 'json';
  node: boolean;
}

/** Whitespace-separated clang flags, the same split as one `--link` value. */
export function splitFlags(raw: string): string[] {
  return raw.split(/\s+/).filter((flag) => flag !== '');
}

/** Precedence (Task 6.18 step 3): command line, then environment, then the file, then the
 * default. `link` concatenates, file first. Paths from the file resolve against its directory;
 * command-line paths stay as given, relative to the current directory. */
export function resolveOptions(
  cli: CliOptions,
  env: { opt: OptLevel | undefined },
  file: LoadedConfig | undefined,
): ResolvedOptions {
  const config: Config = file?.config ?? {};
  const base = file === undefined ? '' : dirname(file.path);
  const fromFile = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : resolve(base, value);
  // A relative path names a file next to the config; a bare name stays a name, found on PATH.
  const local = (value: string | undefined): string | undefined =>
    value?.startsWith('.') === true ? fromFile(value) : value;
  const configCc = local(config.cc);
  return {
    entry: cli.entry ?? fromFile(config.entry),
    out: cli.out ?? fromFile(config.out),
    mode: cli.mode ?? config.mode ?? 'ts',
    opt: cli.opt ?? env.opt ?? config.opt ?? 2,
    link: [...(config.link ?? []).flatMap(splitFlags), ...cli.link],
    emit: cli.emit ?? config.emit ?? 'binary',
    keepC: cli.keepC ?? config.keepC ?? false,
    emitHeader: cli.emitHeader ?? fromFile(config.emitHeader),
    unitName: cli.unitName ?? config.unitName,
    bundler: cli.bundler ?? local(config.bundler),
    cc:
      cli.cc !== undefined
        ? { command: cli.cc, source: '--cc' }
        : configCc === undefined
          ? undefined
          : { command: configCc, source: 'config' },
    diagnostics: cli.diagnostics ?? config.diagnostics ?? 'text',
    node: cli.node ?? config.node ?? false,
  };
}
