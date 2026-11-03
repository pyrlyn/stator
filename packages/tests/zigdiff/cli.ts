// Compares the TS CLI and statorc-zig on every class of usage, config, `.env` and output error:
// standard output, standard error, exit code and the files left behind, each run in a fresh
// directory at one path so a path in a message is the same path. Run on the pinned Node after
// `zig build` in `packages/compiler-zig`:
//   node packages/tests/zigdiff/cli.ts [substring] [--show=<n>]
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTree } from './tree.ts';

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORACLE = join(PACKAGES, 'compiler', 'src', 'cli', 'main.ts');
const ZIG = join(PACKAGES, 'compiler-zig', 'zig-out', 'bin', 'statorc-zig');

interface Case {
  readonly group: string;
  readonly args: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly dirs?: readonly string[];
  readonly cwd?: string;
  /** Read only, so a write fails where the permission says it does. */
  readonly readonly?: readonly string[];
  /** Run this file afterwards and compare what it prints. */
  readonly run?: string;
}

interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly left: readonly string[];
  readonly output?: string;
}

const HELLO = "console.log('hello');\n";
const SOURCE = { 'x.ts': HELLO };

function usageCases(): Case[] {
  const plain: (readonly string[])[] = [
    [],
    ['--help'],
    ['-h'],
    ['help'],
    ['--version'],
    ['-v'],
    ['-V'],
    ['version'],
    ['build', '--help'],
    ['build', '-h'],
    ['explain', '--help'],
    ['explain', '-h'],
    ['build', '--version'],
    ['explain', '--version'],
    ['build', 'x.ts', '--help'],
    ['frob'],
    ['frob', '--help'],
    ['--frob'],
    ['--mode=ts'],
    ['--json'],
    ['-o'],
    ['-'],
    ['--'],
    [''],
  ];
  return plain.map((args) => ({ group: 'usage', args, files: SOURCE }));
}

function flagCases(): Case[] {
  const b = ['build', 'x.ts', '-o', 'a'];
  const e = ['explain', 'x.ts'];
  const build: (readonly string[])[] = [
    ['build'],
    ['explain'],
    ['build', 'x.ts'],
    ['build', '-o'],
    ['build', '-o', 'a'],
    ['build', 'x.ts', '-o'],
    ['build', 'x.ts', '-o', '--emit=c'],
    ['build', 'x.ts', '--out'],
    ['build', 'x.ts', '--out='],
    [...b, 'b.ts'],
    ['build', '--frob', 'x.ts'],
    [...b, '--frob'],
    [...b, '-x'],
    [...b, '--json'],
    [...b, '--diagnostics=json'],
    [...b, '--diagnostics=text'],
    [...b, '--no-config=1'],
    [...b, '--keep-c=1'],
    [...b, '--node=1'],
    [...b, '--help=1'],
    [...b, '--mode=x'],
    [...b, '--mode'],
    [...b, '--mode='],
    [...b, '--mode', 'x'],
    [...b, '--mode', '--node'],
    [...b, '--opt=9'],
    [...b, '--opt='],
    [...b, '--opt'],
    [...b, '--opt=-1'],
    [...b, '--opt=1.5'],
    [...b, '--opt=02'],
    [...b, '--opt=x'],
    [...b, '--opt', '9'],
    [...b, '--opt', '--node'],
    [...b, '-O2'],
    [...b, '--emit=x'],
    [...b, '--emit='],
    [...b, '--emit'],
    [...b, '--emit', 'x'],
    ['build', 'x.ts', '--emit=lib'],
    [...b, '--link='],
    [...b, '--link'],
    [...b, '--link=   '],
    [...b, '--link', '--node'],
    [...b, '--bundler='],
    [...b, '--bundler'],
    [...b, '--bundler=none'],
    [...b, '--bundler=vite'],
    [...b, '--bundler=./x.ts'],
    [...b, '--unit-name=a-b'],
    [...b, '--unit-name='],
    [...b, '--unit-name'],
    [...b, '--unit-name=1a'],
    [...b, '--unit-name=a'],
    [...b, '--emit=lib', '--unit-name=a-b'],
    [...b, '--emit=lib', '--unit-name=1a'],
    [...b, '--emit-header='],
    [...b, '--emit-header'],
    [...b, '--emit-header=a.h'],
    [...b, '--config'],
    [...b, '--config='],
    [...b, '--config=missing.json'],
    [...b, '--config', 'missing.json'],
    [...b, '--config=.'],
    [...b, '--no-config', '--config=missing.json'],
    [...b, '--config=missing.json', '--no-config'],
  ];
  const explain: (readonly string[])[] = [
    [...e, '--emit=c'],
    [...e, '-o', 'a'],
    [...e, '--out=a'],
    [...e, '--keep-c'],
    [...e, '--opt=1'],
    [...e, '--link=-lm'],
    [...e, '--emit-header=a.h'],
    [...e, '--unit-name=a'],
    [...e, '--frob'],
    [...e, 'b.ts'],
    [...e, '--diagnostics=x'],
    [...e, '--diagnostics='],
    [...e, '--diagnostics'],
    [...e, '--diagnostics', 'x'],
    [...e, '--mode=x'],
    [...e, '--bundler=none'],
    [...e, '--bundler='],
    [...e, '--config=missing.json'],
  ];
  return [...build, ...explain].map((args) => ({ group: 'flags', args, files: SOURCE }));
}

function environmentCases(): Case[] {
  const b = ['build', 'x.ts', '-o', 'a'];
  const env: Readonly<Record<string, string>>[] = [
    { STATOR_OPT: '9' },
    { STATOR_OPT: 'x' },
    { STATOR_OPT: '' },
    { STATOR_OPT: '-1' },
    { STATOR_OPT: '02' },
    { STATOR_COMPILE_JOBS: '0' },
    { STATOR_COMPILE_JOBS: 'x' },
    { STATOR_COMPILE_JOBS: '-1' },
    { STATOR_COMPILE_JOBS: '1.5' },
    { STATOR_COMPILE_JOBS: '' },
    { STATOR_COMPILE_JOBS: '99999999999999999999' },
    { STATOR_RUNTIME: 'nope' },
    { STATOR_STD_ROOT: '/nonexistent' },
    { STATOR_NODE_ROOT: '/nonexistent' },
  ];
  const dotenv = [
    'STATOR_OPT=9\n',
    'STATOR_OPT="9"\n',
    "STATOR_OPT='9' # no\n",
    'export STATOR_OPT=9\n',
    'STATOR_OPT = 9\n',
    '# STATOR_OPT=9\n',
    '=9\n',
    'garbage\n',
    '\n',
    'STATOR_OPT=\n',
    'CC=/nonexistent\nSTATOR_RUNTIME_ROOT=/nonexistent\n',
    'STATOR_COMPILE_JOBS=0\n',
    'STATOR_RUNTIME=nope\n',
    'STATOR_OPT=9\r\n',
    'A=1\nB\nSTATOR_OPT=7\n',
    'STATOR_OPT="unterminated\n',
  ];
  return [
    ...env.map((vars) => ({ group: 'env', args: b, files: SOURCE, env: vars, run: 'a' })),
    ...dotenv.map((text) => ({
      group: 'env',
      args: b,
      files: { ...SOURCE, '.env': text },
      run: 'a',
    })),
    { group: 'env', args: b, files: SOURCE, dirs: ['.env'] },
    {
      group: 'env',
      args: b,
      files: { ...SOURCE, '.env': 'STATOR_OPT=9\n' },
      env: { STATOR_OPT: '1' },
    },
    { group: 'env', args: [...b, '--opt=1'], files: { ...SOURCE, '.env': 'STATOR_OPT=9\n' } },
    { group: 'env', args: ['--version'], files: { '.env': 'STATOR_OPT=9\n' } },
    { group: 'env', args: ['explain', 'x.ts'], files: { ...SOURCE, '.env': 'STATOR_OPT=9\n' } },
  ];
}

const REFUSED_CONFIGS = [
  '{"opt":9}',
  '{"mode":"x","opt":"2"}',
  '{"keepC":1,"node":"yes"}',
  '{"entry":""}',
  '{"entry":3}',
  '{"link":"x"}',
  '{"link":[" "]}',
  '{"link":[1,""," x"]}',
  '[]',
  '3',
  'null',
  '{"foo":1,"a/b":2,"t~":3}',
  '{"foo":1,"opt":9,"mode":3,"keepC":"x"}',
  '{"$schema":1}',
  '{"diagnostics":"x","emit":"y"}',
  '{"out":"","emitHeader":"","unitName":1,"bundler":""}',
  '"x"',
  'true',
  '',
  '{',
  '{"a":1,}',
  '// c\n{}',
  '{"a" 1}',
  '{"a":}',
  '[1,]',
  '{} x',
  '{"a":tru}',
  '{"a":"x\ny"}',
  '{"a":01}',
  '{"a":1.}',
  "{'a':1}",
  '{"a":"\\q"}',
  '{"a":"\\u12"}',
  '/* c */ {}',
  '{"a":1',
  '{"a":"x',
  '{a:1}',
  '[1',
  '[1 2]',
  '{"a":1 "b":2}',
  '-',
  '1e',
  '   ',
  '{,}',
  '{"a":NaN}',
  '\ufeff{}',
  '{"a":"\udcff"}',
  '{"\u0001":1}',
  '\t{\n  "a": [1,\n 2,\n]}',
];

function configCases(): Case[] {
  const refused = REFUSED_CONFIGS.flatMap((text) => [
    {
      group: 'config',
      args: ['build', 'x.ts', '-o', 'a'],
      files: { ...SOURCE, 'stator.config.json': text },
    },
    {
      group: 'config',
      args: ['explain', 'x.ts', '--config=c.json'],
      files: { ...SOURCE, 'c.json': text },
    },
    {
      group: 'config',
      args: ['build', 'x.ts', '-o', 'a', '--no-config'],
      files: { ...SOURCE, 'stator.config.json': text },
    },
  ]);
  const json = (value: unknown): string => JSON.stringify(value);
  const c = (
    config: unknown,
    args: readonly string[],
    extra: Readonly<Record<string, string>> = {},
  ): Case => ({
    group: 'config',
    args,
    files: { ...SOURCE, 'stator.config.json': json(config), ...extra },
  });
  const semantic: Case[] = [
    c({ entry: 'x.ts', out: 'a' }, ['build']),
    c({ entry: 'x.ts' }, ['build']),
    c({ out: 'a' }, ['build']),
    c({ entry: 'x.ts', out: 'a' }, ['build', 'x.ts', '-o', 'b']),
    c({ entry: 'missing.ts', out: 'a' }, ['build']),
    c({ entry: 'x.ts', out: 'a', opt: 1 }, ['build', '--opt=2']),
    c({ entry: 'x.ts', out: 'a', opt: 9 }, ['build', '--opt=2']),
    c({ entry: 'x.ts', out: 'a', mode: 'js' }, ['build']),
    c({ entry: 'x.ts', out: 'a', emit: 'c' }, ['build']),
    c({ entry: 'x.ts', out: 'a', keepC: true }, ['build']),
    c({ entry: 'x.ts', out: 'a', link: ['-lm'] }, ['build', '--link=-lz']),
    c({ entry: 'x.ts', out: 'a', link: ['   '] }, ['build']),
    c({ entry: 'x.ts', out: 'a', unitName: 'a-b' }, ['build']),
    c({ entry: 'x.ts', out: 'a', bundler: 'none' }, ['build']),
    c({ entry: 'x.ts', out: 'a', mode: 'js', bundler: 'none' }, ['build']),
    c({ entry: 'x.ts', out: 'a', diagnostics: 'json' }, ['build']),
    c({ entry: 'x.ts', out: 'a', node: true }, ['build']),
    c({ entry: 'x.ts', out: 'a', emitHeader: 'a.h' }, ['build']),
    c({ entry: 'x.ts', diagnostics: 'json' }, ['explain']),
    c({ $schema: 'x', entry: 'x.ts', out: 'a' }, ['build']),
    {
      group: 'config',
      args: ['build', '--config=sub/c.json'],
      files: { 'sub/x.ts': HELLO, 'sub/c.json': json({ entry: 'x.ts', out: 'a' }) },
    },
    {
      group: 'config',
      args: ['build', 'x.ts', '-o', 'a', '--config=sub'],
      files: SOURCE,
      dirs: ['sub'],
    },
    {
      group: 'config',
      args: ['build', 'x.ts', '-o', 'a', '--config=sub/c.json'],
      files: { ...SOURCE, 'sub/c.json': '{' },
    },
    {
      group: 'config',
      args: ['build', 'x.ts', '-o', 'a'],
      files: SOURCE,
      dirs: ['stator.config.json'],
    },
    {
      group: 'config',
      args: ['build', 'x.ts', '-o', 'a', '--config=c.json'],
      files: { ...SOURCE, 'c.json': '{}' },
      readonly: ['c.json'],
    },
  ];
  return [...refused, ...semantic];
}

function entryCases(): Case[] {
  const entries: Readonly<Record<string, string>> = {
    'x.txt': 'x',
    'x.js': HELLO,
    'x.mjs': HELLO,
    'x.cjs': HELLO,
    'x.tsx': HELLO,
    'x.jsx': HELLO,
    'x.d.ts': 'export {};\n',
    'x.json': '{}',
    'x.mts': HELLO,
    'x.cts': HELLO,
    x: HELLO,
    '.ts': HELLO,
  };
  const out: Case[] = [];
  for (const [name, text] of Object.entries(entries)) {
    for (const mode of ['ts', 'js']) {
      out.push({
        group: 'entry',
        args: ['build', name, '-o', 'a', `--mode=${mode}`],
        files: { [name]: text },
      });
      out.push({
        group: 'entry',
        args: ['explain', name, `--mode=${mode}`],
        files: { [name]: text },
      });
      out.push({
        group: 'entry',
        args: ['explain', name, `--mode=${mode}`, '--json'],
        files: { [name]: text },
      });
    }
  }
  const missing: (readonly string[])[] = [
    ['build', 'missing.ts', '-o', 'a'],
    ['explain', 'missing.ts'],
    ['explain', 'missing.ts', '--json'],
    ['build', 'dir', '-o', 'a'],
    ['explain', 'dir'],
    ['build', 'nope/x.ts', '-o', 'a'],
    ['build', 'dir/', '-o', 'a'],
  ];
  for (const args of missing) out.push({ group: 'entry', args, dirs: ['dir'] });
  const programs: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    type: { 'x.ts': 'const n: number = "a";\n' },
    any: { 'x.ts': 'const n: any = 1;\nconsole.log(n);\n' },
    evalled: { 'x.ts': "eval('1');\n" },
    syntax: { 'x.ts': 'const = ;\n' },
    unresolved: { 'x.ts': "import './missing.ts';\n" },
    cycle: {
      'x.ts': "import { b } from './y.ts';\nexport const a = 1;\nconsole.log(b);\n",
      'y.ts': "import { a } from './x.ts';\nexport const b = a;\n",
    },
    many: {
      'x.ts':
        'const a: number = "a";\nconst b: number = "b";\nconst c: any = 1;\nconsole.log(a, b, c);\n',
    },
    builtin: { 'x.ts': "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync);\n" },
    stdUnknown: { 'x.ts': "import { x } from 'std/nope';\nconsole.log(x);\n" },
  };
  for (const files of Object.values(programs)) {
    for (const flags of [['--mode=ts'], ['--mode=js'], ['--node'], ['--mode=js', '--node']]) {
      out.push({ group: 'frontend', args: ['build', 'x.ts', '-o', 'a', ...flags], files });
      out.push({ group: 'frontend', args: ['explain', 'x.ts', ...flags], files });
      out.push({ group: 'frontend', args: ['explain', 'x.ts', '--json', ...flags], files });
    }
  }
  return out;
}

function outputCases(): Case[] {
  const files = { 'x.ts': "import './y.ts';\nconsole.log('x');\n", 'y.ts': "console.log('y');\n" };
  const flags: (readonly string[])[] = [
    ['-o', 'x.ts'],
    ['-o', 'y.ts'],
    ['-o', './x.ts'],
    ['-o', 'a', '--emit-header=a', '--emit=lib'],
    ['-o', 'a', '--keep-c', '--emit-header=a.c', '--emit=lib'],
    ['-o', 'x', '--keep-c', '--emit-header=x.c'],
    ['-o', 'dir'],
    ['-o', 'nope/a'],
    ['-o', 'locked/a'],
    ['-o', 'a', '--keep-c'],
    ['-o', 'a', '--opt=0'],
    ['-o', 'a', '--opt=1'],
    ['-o', 'a', '--opt=3'],
    ['-o', 'a', '--link=-lm'],
    ['-o', 'a', '--link=-lnope'],
    ['-o', 'a', '--link=--nope'],
    ['-o', 'a.c', '--emit=c'],
    ['-o', 'nope/a.c', '--emit=c'],
    ['-o', 'x.ts', '--emit=c'],
    ['--emit=c'],
    ['-o', 'a.o', '--emit=lib'],
    ['-o', 'liba.a', '--emit=lib'],
    ['-o', 'liba.a', '--emit=lib', '--unit-name=a_b'],
    ['-o', 'nope/liba.a', '--emit=lib'],
    ['-o', 'x.ts', '--emit=lib'],
    ['-o', 'a.txt', '--emit=lib'],
  ];
  const cases: Case[] = flags.map((extra) => ({
    group: 'output',
    args: ['build', 'x.ts', ...extra],
    files,
    dirs: ['dir', 'locked'],
    readonly: ['locked'],
  }));
  const env: Readonly<Record<string, string>>[] = [
    { CC: '/nonexistent/cc' },
    { CC: 'false' },
    { CC: 'nope-clang' },
    { STATOR_RUNTIME_ROOT: '/nonexistent' },
    { AR: '/nonexistent' },
  ];
  for (const vars of env) {
    cases.push({ group: 'output', args: ['build', 'x.ts', '-o', 'a'], files, env: vars });
    cases.push({
      group: 'output',
      args: ['build', 'x.ts', '-o', 'a.o', '--emit=lib'],
      files,
      env: vars,
    });
    cases.push({
      group: 'output',
      args: ['build', 'x.ts', '-o', 'liba.a', '--emit=lib'],
      files,
      env: vars,
    });
  }
  return cases;
}

function wrapCases(): Case[] {
  const long = `${'y'.repeat(50)}/${'z'.repeat(50)}.ts`;
  const cases: Case[] = [];
  for (const width of ['20', '40', '79', '80', '81', '200', '0', 'x']) {
    for (const lines of [undefined, '24']) {
      const env = { COLUMNS: width, ...(lines === undefined ? {} : { LINES: lines }) };
      cases.push({ group: 'wrap', args: ['frob-'.repeat(30)], env });
      cases.push({ group: 'wrap', args: ['build', long, '-o', 'a'], env });
      cases.push({ group: 'wrap', args: ['--help'], env });
      cases.push({
        group: 'wrap',
        args: ['build', 'x.ts', '-o', 'a'],
        files: { 'x.ts': 'const value: number = "a long string that is not a number at all";\n' },
        env,
      });
    }
  }
  return cases;
}

function deepCases(): Case[] {
  const depth = 200_000;
  const nested = (open: string, inner: string, close: string): string =>
    `const x = ${open.repeat(depth)}${inner}${close.repeat(depth)};\n`;
  return [nested('(', '1', ')'), nested('[', '', ']')].map((text) => ({
    group: 'deep',
    args: ['build', 'x.ts', '-o', 'a'],
    files: { 'x.ts': text },
  }));
}

function fixture(root: string, item: Case): void {
  writeTree(root, item.files ?? {}, item.dirs ?? []);
  for (const name of item.readonly ?? []) chmodSync(join(root, name), 0o500);
}

function restore(root: string, item: Case): void {
  for (const name of item.readonly ?? []) chmodSync(join(root, name), 0o700);
}

function leftBehind(root: string, at = ''): string[] {
  return readdirSync(join(root, at))
    .sort()
    .flatMap((name) => {
      const path = join(at, name);
      if (statSync(join(root, path)).isDirectory()) return [`${path}/`, ...leftBehind(root, path)];
      // Binary contents legitimately differ in their paths; C and text do not.
      const text = /\.(c|h|pc|json|env)$/.test(name)
        ? `:${readFileSync(join(root, path), 'utf8')}`
        : '';
      return [`${path}${text}`];
    });
}

function hostEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: process.env['HOME'], ...extra };
  return env;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text));
    child.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

async function outcome(
  root: string,
  item: Case,
  command: string,
  args: readonly string[],
): Promise<Outcome> {
  fixture(root, item);
  const env = hostEnvironment(item.env ?? {});
  const cwd = join(root, item.cwd ?? '');
  const result = await run(command, args, cwd, env);
  restore(root, item);
  const output =
    item.run === undefined
      ? undefined
      : spawnSync(join(root, item.run), { encoding: 'utf8' }).stdout;
  return { ...result, left: leftBehind(root), ...(output === undefined ? {} : { output }) };
}

const filterArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const show = Number(
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--show='))
    ?.slice('--show='.length) ?? 20,
);
const cases = [
  ...usageCases(),
  ...flagCases(),
  ...environmentCases(),
  ...configCases(),
  ...entryCases(),
  ...outputCases(),
  ...wrapCases(),
  ...deepCases(),
].filter((item) => filterArg === undefined || item.group === filterArg);

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stator-cli-parity-')));
const tally: Record<string, { same: number; total: number }> = {};
const misses: string[] = [];
let next = 0;

async function worker(): Promise<void> {
  for (;;) {
    const index = next++;
    const item = cases[index];
    if (item === undefined) return;
    const root = join(base, String(index));
    const tag = `${item.group} ${JSON.stringify(item.args)} ${JSON.stringify(item.env ?? {})}`;
    const count = (tally[item.group] ??= { same: 0, total: 0 });
    count.total += 1;
    const oracle = await outcome(root, item, process.execPath, [ORACLE, ...item.args]);
    const zig = await outcome(root, item, ZIG, item.args);
    if (JSON.stringify(oracle) === JSON.stringify(zig)) {
      count.same += 1;
      continue;
    }
    const fields = (['code', 'stdout', 'stderr', 'left', 'output'] as const).filter(
      (field) => JSON.stringify(oracle[field]) !== JSON.stringify(zig[field]),
    );
    const detail = fields.map(
      (field) =>
        `  ${field}:\n    oracle ${JSON.stringify(oracle[field])}\n    zig    ${JSON.stringify(zig[field])}`,
    );
    misses.push(`${tag}\n${detail.join('\n').replaceAll(base, '@')}`);
  }
}

await Promise.all(Array.from({ length: 6 }, worker));
rmSync(base, { recursive: true, force: true });
for (const miss of misses.slice(0, show)) console.log(miss);
console.log(
  JSON.stringify({
    cases: cases.length,
    same: cases.length - misses.length,
    misses: misses.length,
    tally,
  }),
);
