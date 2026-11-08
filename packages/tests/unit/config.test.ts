/* `stator.config.json` (plan.md §9 Task 6.18): discovery, precedence, the three STA codes, and
 * the drift test that keeps the committed JSON Schema equal to the one `config.ts` generates.
 * Precedence is tested in-process on `resolveOptions`; the spawns only prove `parse()` wires it. */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { test } from 'vitest';
import {
  type CliOptions,
  configSchemaDocument,
  loadConfig,
  resolveOptions,
} from '../../compiler/src/cli/config.ts';
import { BuildError } from '../../compiler/src/support/diagnostics.ts';
import { SCHEMA_PATH } from '../support/config-schema.ts';

const CLI = fileURLToPath(new URL('../../compiler/src/cli/main.ts', import.meta.url));

const NO_FLAGS: CliOptions = {
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
};

/** Every key, each with a non-default value. */
const FULL = {
  $schema: './node_modules/statorc/schema/stator.config.schema.json',
  entry: 'src/main.ts',
  out: 'build/app',
  mode: 'js',
  opt: 3,
  link: ['-lm -L/opt/lib', '-lz'],
  emit: 'c',
  keepC: true,
  emitHeader: 'build/app.h',
  unitName: 'app',
  bundler: './adapter.ts',
  cc: './tools/cc',
  diagnostics: 'json',
  node: true,
};

/** A fresh directory holding `files` (name → text). */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stator-config-'));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function throwsCode(code: string, run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof BuildError, `expected a BuildError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  });
}

test('every key from the file alone; paths resolve against the file directory', () => {
  const dir = project({ 'stator.config.json': JSON.stringify(FULL) });
  const file = loadConfig({ kind: 'discover' }, dir);
  assert.ok(file);
  assert.deepEqual(resolveOptions(NO_FLAGS, { opt: undefined }, file), {
    entry: join(dir, 'src/main.ts'),
    out: join(dir, 'build/app'),
    mode: 'js',
    opt: 3,
    link: ['-lm', '-L/opt/lib', '-lz'],
    emit: 'c',
    keepC: true,
    emitHeader: join(dir, 'build/app.h'),
    unitName: 'app',
    bundler: join(dir, 'adapter.ts'),
    cc: { command: join(dir, 'tools/cc'), source: 'config' },
    diagnostics: 'json',
    node: true,
  });
});

test('every key overridden from the command line; link concatenates, file first', () => {
  const dir = project({
    'stator.config.json': JSON.stringify({
      ...FULL,
      emit: 'c',
      keepC: false,
      diagnostics: 'json',
      node: false,
    }),
  });
  const file = loadConfig({ kind: 'discover' }, dir);
  const cli: CliOptions = {
    entry: 'other.ts',
    out: 'other',
    mode: 'ts',
    opt: 0,
    link: ['-lsqlite3'],
    emit: 'binary',
    keepC: true,
    emitHeader: 'other.h',
    unitName: 'other',
    bundler: 'none',
    cc: 'gcc',
    diagnostics: 'text',
    node: true,
  };
  assert.deepEqual(resolveOptions(cli, { opt: 1 }, file), {
    entry: 'other.ts',
    out: 'other',
    mode: 'ts',
    opt: 0,
    link: ['-lm', '-L/opt/lib', '-lz', '-lsqlite3'],
    emit: 'binary',
    keepC: true,
    emitHeader: 'other.h',
    unitName: 'other',
    bundler: 'none',
    cc: { command: 'gcc', source: '--cc' },
    diagnostics: 'text',
    node: true,
  });
});

test('the environment sits between the command line and the file', () => {
  const file = loadConfig({ kind: 'discover' }, project({ 'stator.config.json': '{"opt":3}' }));
  assert.equal(resolveOptions(NO_FLAGS, { opt: 1 }, file).opt, 1);
  assert.equal(resolveOptions(NO_FLAGS, { opt: undefined }, file).opt, 3);
  assert.equal(resolveOptions({ ...NO_FLAGS, opt: 0 }, { opt: 1 }, file).opt, 0);
});

test('no file and no flags give the built-in defaults', () => {
  assert.equal(loadConfig({ kind: 'discover' }, project({})), undefined);
  assert.deepEqual(resolveOptions(NO_FLAGS, { opt: undefined }, undefined), {
    entry: undefined,
    out: undefined,
    mode: 'ts',
    opt: 2,
    link: [],
    emit: 'binary',
    keepC: false,
    emitHeader: undefined,
    unitName: undefined,
    bundler: undefined,
    cc: undefined,
    diagnostics: 'text',
    node: false,
  });
});

test('--no-config skips even a broken file', () => {
  const dir = project({ 'stator.config.json': '{ broken' });
  assert.equal(loadConfig({ kind: 'none' }, dir), undefined);
});

test('--config reads the named file, relative to the current directory', () => {
  const dir = project({ 'other.json': '{"mode":"js"}' });
  assert.equal(loadConfig({ kind: 'path', path: 'other.json' }, dir)?.config.mode, 'js');
});

test('a missing --config path is STA0018; a missing discovered file is no file', () => {
  const dir = project({});
  throwsCode('STA0018', () => loadConfig({ kind: 'path', path: 'nope.json' }, dir), /nope\.json/);
});

test('invalid JSON is STA0016 with the line and column', () => {
  const dir = project({ 'stator.config.json': '{\n  "mode": ,\n}\n' });
  throwsCode('STA0016', () => loadConfig({ kind: 'discover' }, dir), /stator\.config\.json:2:11:/);
  // JSON, not JSONC: a comment or a trailing comma is an error too.
  const jsonc = project({ 'stator.config.json': '{ "mode": "js", }' });
  throwsCode('STA0016', () => loadConfig({ kind: 'discover' }, jsonc), /:1:17:/);
});

test('an unreadable file is STA0016', () => {
  const dir = project({});
  mkdirSync(join(dir, 'stator.config.json'));
  throwsCode('STA0016', () => loadConfig({ kind: 'discover' }, dir), /cannot read/);
});

test('a schema violation is STA0017 with the JSON pointer and the expected type', () => {
  const dir = project({
    'stator.config.json': JSON.stringify({ mode: 'py', keepC: 'yes', link: ['-lm', 3] }),
  });
  throwsCode(
    'STA0017',
    () => loadConfig({ kind: 'discover' }, dir),
    /\/mode: expected one of "ts", "js".*\/link\/1: must be string.*\/keepC: must be boolean/,
  );
  const array = project({ 'stator.config.json': '[]' });
  throwsCode('STA0017', () => loadConfig({ kind: 'discover' }, array), /\/: must be object/);
});

test('an unknown key is STA0017, so a typo cannot pass silently', () => {
  const dir = project({ 'stator.config.json': '{"mdoe":"js"}' });
  throwsCode('STA0017', () => loadConfig({ kind: 'discover' }, dir), /\/mdoe: unknown key/);
});

test('the flags that pick the file have no key in it', () => {
  for (const key of ['config', 'noConfig', 'help', 'version']) {
    const dir = project({ 'stator.config.json': JSON.stringify({ [key]: true }) });
    throwsCode('STA0017', () => loadConfig({ kind: 'discover' }, dir), /unknown key/);
  }
});

test('drift: the committed schema equals the one config.ts generates (pnpm run schema:config)', () => {
  const committed: unknown = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(configSchemaDocument())));
});

test('parse() reads ./stator.config.json, the command line wins, --no-config and --config work', async () => {
  const dir = project({
    'main.js': 'console.log(1);\n',
    'stator.config.json': '{"entry":"main.js","mode":"js","diagnostics":"json"}',
  });
  const run = (...args: string[]) =>
    execa(process.execPath, [CLI, 'explain', ...args], { cwd: dir, reject: false });
  const [fromFile, overridden, skipped, missing] = await Promise.all([
    run(),
    run('--mode=ts'),
    run('--no-config', 'main.js'),
    run('--config=missing.json'),
  ]);
  assert.equal(fromFile.stdout, '{"verdict":"static","functions":[]}');
  assert.match(overridden.stdout, /"code":"STA1002"/);
  // Without the file the mode is ts again and the report is text, not JSON.
  assert.match(skipped.stdout, /^main\.js: error \(STA1002\)/);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /STA0018/);
});
