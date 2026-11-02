// Compares `packages/compiler/src/ffi-gen/main.ts` and `statorc-zig ffi-gen` on every FFI input the
// repository holds, then on seeded mutations of them: exit code, standard output, standard error
// and the files left behind, each run in a fresh directory at one path. Run on the pinned Node after
// `zig build` in `packages/compiler-zig`:
//   node packages/tests/zigdiff/ffigen.ts [--zig=<bin>] [--mutations=<n>] [--seed=<n>] [--only=<group>] [--show=<n>]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { writeTree } from './tree.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ORACLE = join(REPO, 'packages', 'compiler', 'src', 'ffi-gen', 'main.ts');

function flag(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const ZIG = resolve(
  flag('zig') ?? join(REPO, 'packages', 'compiler-zig', 'zig-out', 'bin', 'statorc-zig'),
);
const MUTATIONS = Number(flag('mutations') ?? '300');
const SEED = Number(flag('seed') ?? '1');
const ONLY = flag('only');
const SHOW = Number(flag('show') ?? '5');
const WORKERS = Number(flag('workers') ?? '6');

interface Case {
  readonly group: string;
  readonly name: string;
  readonly args: readonly string[];
  readonly files: Readonly<Record<string, Buffer | string>>;
  readonly executable?: readonly string[];
  readonly dirs?: readonly string[];
}

interface Outcome {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly left: readonly string[];
}

function git(...args: readonly string[]): string[] {
  const run = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.split('\n').filter((line) => line !== '');
}

function repoFile(path: string): Buffer {
  return readFileSync(join(REPO, path));
}

interface Named {
  readonly name: string;
  readonly bytes: Buffer;
}

/** Every string `ffi-gen-binding.test.ts` writes to a file: its inline headers and bindings. */
function inlineInputs(): { readonly headers: Named[]; readonly hand: Named[] } {
  const path = join(REPO, 'packages', 'tests', 'unit', 'ffi-gen-binding.test.ts');
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const headers: Named[] = [];
  const hand: Named[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    const looksHand = value.includes('declare function');
    const list = looksHand ? hand : headers;
    list.push({
      name: `inline${seen.size}.${looksHand ? 'd.ts' : 'h'}`,
      bytes: Buffer.from(value),
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === 'SAMPLE_HEADER' &&
      node.initializer !== undefined &&
      ts.isNoSubstitutionTemplateLiteral(node.initializer)
    ) {
      add(node.initializer.text);
    }
    if (ts.isCallExpression(node) && node.expression.getText() === 'writeFileSync') {
      const value = node.arguments[1];
      if (
        value !== undefined &&
        (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
      )
        add(value.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { headers, hand };
}

function trackedHeaders(): Named[] {
  const headers = git('ls-files', 'packages/tests', 'examples').filter((path) =>
    path.endsWith('.h'),
  );
  return headers.map((path) => ({ name: basename(path), bytes: repoFile(path) }));
}

function trackedSources(): Named[] {
  const sources = git('ls-files', 'packages/tests', 'examples').filter((path) =>
    path.endsWith('.c'),
  );
  return sources.map((path) => ({ name: basename(path), bytes: repoFile(path) }));
}

function handFiles(): Named[] {
  const found = git(
    'grep',
    '-l',
    '-E',
    'statorExtern|ffi-gen',
    '--',
    'packages/tests',
    'examples',
  ).filter((path) => /\.(d\.ts|ts|js|mjs|cjs)$/.test(path));
  return found.map((path) => ({ name: basename(path), bytes: repoFile(path) }));
}

function realCases(headers: readonly Named[], hand: readonly Named[]): Case[] {
  const cases: Case[] = [];
  for (const h of headers) {
    const files = { [h.name]: h.bytes };
    cases.push({ group: 'header', name: `${h.name} plain`, args: [h.name], files });
    cases.push({
      group: 'header',
      name: `${h.name} --out`,
      args: [h.name, '--out=gen.d.ts'],
      files,
    });
    cases.push({
      group: 'header',
      name: `${h.name} libs`,
      args: [h.name, '--lib=m', '--lib=sqlite3', '-DX=1', '-I.'],
      files,
    });
    for (const d of hand) {
      const name = `hand_${d.name}`;
      cases.push({
        group: 'diff',
        name: `${h.name} vs ${d.name}`,
        args: [h.name, `--diff=${name}`],
        files: { ...files, [name]: d.bytes },
      });
    }
    const first = hand[0];
    if (first !== undefined) {
      cases.push({
        group: 'diff',
        name: `${h.name} both`,
        args: [h.name, '--diff=hand.d.ts', '--out=gen.d.ts'],
        files: { ...files, 'hand.d.ts': first.bytes },
      });
    }
  }
  return cases;
}

function sourceCases(sources: readonly Named[]): Case[] {
  return sources.map((s) => ({
    group: 'source',
    name: s.name,
    args: [s.name, '-I.'],
    files: { [s.name]: s.bytes },
  }));
}

function argumentCases(): Case[] {
  const h = {
    'h.h': 'int add(int a, int b);\n',
    'hand.d.ts': '/** @statorExtern add */\ndeclare function add(a: number, b: number): number;\n',
  };
  const lists: (readonly string[])[] = [
    [],
    ['--help'],
    ['-h'],
    ['h.h', '--help'],
    ['--frob', '--help'],
    ['--frob'],
    ['-x'],
    ['-'],
    ['--'],
    ['h.h', 'h.h'],
    ['h.h', 'other.h'],
    ['--out='],
    ['h.h', '--out='],
    ['h.h', '--diff='],
    ['h.h', '--clang='],
    ['h.h', '--lib='],
    ['h.h', '--lib=a b'],
    ['h.h', '--lib=a\nb'],
    ['h.h', '--lib="'],
    ['h.h', '--lib=é'],
    ['h.h', '--lib=a\\b'],
    ['h.h', '--lib=m', '--lib=', '--lib=x y'],
    ['h.h', '--out=h.h'],
    ['h.h', '--out=./h.h'],
    ['h.h', '--out=../case/h.h'],
    ['h.h', '--diff=hand.d.ts', '--out=hand.d.ts'],
    ['h.h', '--out=link.h'],
    ['h.h', '--diff=hand.d.ts', '--out=hard.d.ts'],
    ['missing.h'],
    ['.'],
    ['dir'],
    ['h.h', '--diff=missing.d.ts'],
    ['h.h', '--diff=.'],
    ['h.h', '--diff=dir'],
    ['h.h', '--out=dir'],
    ['h.h', '--out=missing/x.d.ts'],
    ['h.h', '--out=dir/x.d.ts'],
    ['h.h', '--clang=/nonexistent/cc'],
    ['h.h', '--clang=./plain'],
    ['h.h', '--clang=./fail'],
    ['h.h', '--clang=./fail-long'],
    ['h.h', '--clang=./fail-signal'],
    ['h.h', '--clang=./silent'],
    ['h.h', '--clang=./array'],
    ['h.h', '--clang=./null'],
    ['h.h', '--clang=./number'],
    ['h.h', '--clang=./bad-utf8'],
    ['h.h', '--clang=dir'],
    ['h.h', '-Dbad name'],
    ['h.h', '-I'],
    ['h.h', '-D'],
    ['h.h', '-Imissing'],
    ['-DX', 'h.h'],
    ['--lib=m', 'h.h', '--lib=z'],
    ['--out=a.d.ts', '--out=b.d.ts', 'h.h'],
    ['--clang=/nonexistent/cc', '--clang=clang', 'h.h'],
  ];
  const script = (body: string): string => `#!/bin/sh\n${body}\n`;
  const scripts: Record<string, string> = {
    fail: script('echo one >&2; exit 7'),
    'fail-long': script('printf "\\n1\\n2\\n3\\n4\\n5\\n6\\n7\\n" >&2; exit 2'),
    'fail-signal': script('kill -KILL $$'),
    silent: script('exit 0'),
    array: script('echo "[1,2]"'),
    null: script('echo null'),
    number: script('echo 3'),
    'bad-utf8': script(
      'printf "\\377" >&2; printf "{\\"inner\\":[{\\"kind\\":\\"FunctionDecl\\",\\"name\\":\\"a\\\\xff\\"}]}"',
    ),
  };
  return lists.map((args, index) => ({
    group: 'args',
    name: `${index}: ${JSON.stringify(args)}`,
    args,
    files: { ...h, ...scripts, plain: 'not executable\n', 'dir/keep': '' },
    executable: Object.keys(scripts),
    dirs: ['dir'],
  }));
}

function stressCases(): Case[] {
  const runtime = git('ls-files', 'packages/runtime/include').filter((path) => path.endsWith('.h'));
  const cases: Case[] = runtime.map((path) => ({
    group: 'stress',
    name: path,
    args: [basename(path), `-I${join(REPO, 'packages', 'runtime', 'include')}`],
    files: { [basename(path)]: repoFile(path) },
  }));
  const sdk = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
  if (sdk.status === 0) {
    const include = join(sdk.stdout.trim(), 'usr', 'include');
    for (const name of [
      'stdio.h',
      'stdlib.h',
      'string.h',
      'math.h',
      'sqlite3.h',
      'time.h',
      'unistd.h',
      'pthread.h',
      'zlib.h',
      'curses.h',
    ]) {
      cases.push({ group: 'stress', name: `sdk ${name}`, args: [join(include, name)], files: {} });
    }
  }
  return cases;
}

class Rng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32: the corpus must replay from `--seed` alone. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(bound: number): number {
    return Math.floor(this.next() * bound);
  }

  pick<T>(list: readonly T[]): T {
    const value = list[this.int(list.length)];
    if (value === undefined) throw new Error('empty pick');
    return value;
  }
}

const C_TOKENS = [
  'struct S',
  'struct S *',
  'union U',
  '*',
  '**',
  '***',
  '(*f)(int)',
  '[3]',
  'const ',
  'volatile ',
  'restrict ',
  '...',
  'long long ',
  '__int128 ',
  '_Complex double ',
  'inline ',
  'static ',
  '{ }',
  '{',
  '}',
  ';',
  ',',
  '(',
  ')',
  '\n#define Q 1\n',
  '\n#define F(x) x\n',
  '\n#define é 2\n',
  '\nenum { A, B };\n',
  '\nenum E { C = 3 };\n',
  '\ntypedef struct { int a : 1; } B;\n',
  '\ntypedef union { int a; } V;\n',
  '\ntypedef struct T T;\n',
  '\ntypedef int X;\n',
  '\ntypedef X *Y;\n',
  '\ntypedef Y *Z;\n',
  '\nint g;\n',
  '\nextern const char *names[];\n',
  'é',
  '\r',
  '\r\n',
  ' ',
  ' ',
  '﻿',
  'size_t ',
  'ssize_t ',
  'int64_t ',
  'unsigned ',
  'bool ',
  'va_list ',
  'void ',
  'char ',
  '__attribute__((unused)) ',
  '\n#include <stdint.h>\n',
  '\n#include <stddef.h>\n',
  '\n#include <stdbool.h>\n',
  '\n#include <stdarg.h>\n',
  '\nvoid fn_a(void);\n',
  '\nvoid delete(void);\n',
  '\nvoid a_b__c_(int class, int p1, int p1);\n',
  '\nvoid ñu_ßa(void);\n',
  '\nstatic int s(void) { return 0; }\n',
  '\nint body(void) { return 1; }\n',
  '\nint v(int, ...);\n',
  '\n#ifndef G\n#define G\n',
  '\n#endif\n',
  '//',
  '/*',
  '*/',
  '"',
  "'",
  '\\',
  '#',
];

const TS_TOKENS = [
  '/** @statorExtern x */',
  '/** @statorExtern */',
  '/**\n * @statorExtern y\n */',
  '/** {@link a} @statorExtern z {@link b} */',
  '@',
  '`',
  '*/',
  '/*',
  '/**',
  '//',
  '\n',
  ';',
  ',',
  ':',
  '(',
  ')',
  '{',
  '}',
  '<T>',
  '<',
  '>',
  '?',
  '...',
  '=',
  'declare function z(a: number): void;\n',
  'export ',
  'default ',
  'declare ',
  'function ',
  'async ',
  'asserts x',
  'this: T',
  'x is string',
  'number',
  'string',
  'CString',
  'Out<T>',
  '\r',
  'é',
  ' ',
  '﻿',
  'class ',
  'interface ',
  'type ',
  'namespace ',
  'enum ',
  'import ',
  '`${',
  '"',
  "'",
];

const WORDS = ['null', '3', '"x"', '[]', '{}', 'true', '-1', '1.5', '1e400', '""'];

function splice(bytes: Buffer, at: number, remove: number, insert: Buffer): Buffer {
  return Buffer.concat([bytes.subarray(0, at), insert, bytes.subarray(at + remove)]);
}

function mutate(input: Buffer, tokens: readonly string[], rng: Rng): Buffer {
  let out = input;
  const rounds = 1 + rng.int(3);
  for (let round = 0; round < rounds; round += 1) {
    const at = rng.int(out.length + 1);
    switch (rng.int(7)) {
      case 0:
        out = splice(out, at, 1, Buffer.from([rng.int(256)]));
        break;
      case 1:
        out = splice(out, at, 1 + rng.int(32), Buffer.alloc(0));
        break;
      case 2:
        out = out.subarray(0, at);
        break;
      case 3:
      case 4:
        out = splice(out, at, 0, Buffer.from(rng.pick(tokens)));
        break;
      case 5: {
        const start = out.lastIndexOf(10, at) + 1;
        const end = out.indexOf(10, at);
        out = splice(out, at, 0, out.subarray(start, end < 0 ? out.length : end + 1));
        break;
      }
      default:
        out = splice(
          out,
          at,
          0,
          Buffer.from(Array.from({ length: 1 + rng.int(4) }, () => 0x80 + rng.int(0x80))),
        );
    }
  }
  return out;
}

function mutatedHeaders(headers: readonly Named[], rng: Rng): Case[] {
  const cases: Case[] = [];
  for (let index = 0; index < MUTATIONS; index += 1) {
    const base = rng.pick(headers);
    const bytes = mutate(base.bytes, C_TOKENS, rng);
    cases.push({
      group: 'mutated-header',
      name: `${index} of ${base.name}`,
      args: [base.name],
      files: { [base.name]: bytes },
    });
  }
  return cases;
}

function mutatedHand(headers: readonly Named[], hand: readonly Named[], rng: Rng): Case[] {
  const cases: Case[] = [];
  for (let index = 0; index < MUTATIONS; index += 1) {
    const base = rng.pick(headers);
    const other = rng.pick(hand);
    cases.push({
      group: 'mutated-hand',
      name: `${index} of ${other.name}`,
      args: [base.name, '--diff=hand.d.ts'],
      files: { [base.name]: base.bytes, 'hand.d.ts': mutate(other.bytes, TS_TOKENS, rng) },
    });
  }
  return cases;
}

/** Undefined for a test string clang refuses: there is no dump of it to mutate. */
function astDump(header: Named): Buffer | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'ffigen-dump-'));
  writeFileSync(join(dir, header.name), header.bytes);
  const run = spawnSync('clang', ['-Xclang', '-ast-dump=json', '-fsyntax-only', header.name], {
    cwd: dir,
    maxBuffer: 1 << 28,
  });
  rmSync(dir, { recursive: true, force: true });
  return run.status === 0 ? run.stdout : undefined;
}

/** Replaces or drops one value of the dump, so a parse succeeds and the tree lies. */
function mutateTree(root: unknown, rng: Rng): void {
  let node = root;
  for (let depth = 0; depth < 40; depth += 1) {
    if (typeof node !== 'object' || node === null) return;
    const holder = node as Record<string, unknown>;
    const keys = Object.keys(holder);
    const key = keys[rng.int(keys.length)];
    if (key === undefined) return;
    const child = holder[key];
    const leaf = typeof child !== 'object' || child === null;
    if (leaf || rng.int(6) === 0) {
      if (rng.int(4) === 0) delete holder[key];
      else holder[key] = JSON.parse(rng.pick(WORDS)) as unknown;
      return;
    }
    node = child;
  }
}

function mutatedDumps(headers: readonly Named[], rng: Rng): Case[] {
  const dumps = headers.flatMap((header) => {
    const dump = astDump(header);
    return dump === undefined ? [] : [{ header, dump }];
  });
  const cases: Case[] = [];
  const clang = '#!/bin/sh\ncat "$(dirname "$0")/dump.json"\n';
  for (let index = 0; index < MUTATIONS; index += 1) {
    const { header, dump } = rng.pick(dumps);
    let bytes: Buffer;
    if (rng.int(3) === 0) {
      bytes = mutate(dump, WORDS, rng);
    } else {
      const tree = JSON.parse(dump.toString('utf8')) as unknown;
      for (let round = 1 + rng.int(8); round > 0; round -= 1) mutateTree(tree, rng);
      bytes = Buffer.from(JSON.stringify(tree));
    }
    cases.push({
      group: 'mutated-dump',
      name: `${index} of ${header.name}`,
      args: [header.name, '--clang=./fake'],
      files: { [header.name]: header.bytes, fake: clang, 'dump.json': bytes },
      executable: ['fake'],
    });
  }
  return cases;
}

function deepCases(): Case[] {
  const deep = 'int ' + '('.repeat(5000) + 'x' + ')'.repeat(5000) + ';\n';
  const wide = Array.from({ length: 20000 }, (_, i) => `int fn_${i}(int a);\n`).join('');
  const long = `int f(${Array.from({ length: 2000 }, (_, i) => `const char *p${i}`).join(', ')});\n`;
  const nest = `/** @statorExtern a */\ndeclare function a(x: ${'('.repeat(3000)}number${')'.repeat(3000)}): void;\n`;
  return [
    { group: 'deep', name: 'deep declarator', args: ['h.h'], files: { 'h.h': deep } },
    { group: 'deep', name: 'wide', args: ['h.h'], files: { 'h.h': wide } },
    { group: 'deep', name: 'long', args: ['h.h'], files: { 'h.h': long } },
    {
      group: 'deep',
      name: 'nested hand',
      args: ['h.h', '--diff=hand.d.ts'],
      files: { 'h.h': 'void a(double x);\n', 'hand.d.ts': nest },
    },
    { group: 'deep', name: 'empty header', args: ['h.h'], files: { 'h.h': '' } },
    {
      group: 'deep',
      name: 'empty hand',
      args: ['h.h', '--diff=hand.d.ts'],
      files: { 'h.h': 'void a(void);\n', 'hand.d.ts': '' },
    },
  ];
}

function prepare(dir: string, c: Case): void {
  writeTree(dir, c.files, c.dirs ?? []);
  for (const name of c.executable ?? []) chmodSync(join(dir, name), 0o755);
  if (c.group === 'args') {
    spawnSync('ln', ['-s', 'h.h', 'link.h'], { cwd: dir });
    spawnSync('ln', ['hand.d.ts', 'hard.d.ts'], { cwd: dir });
  }
}

function listing(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) out.push(`${path}/`, ...listing(dir, path));
    else if (entry.isSymbolicLink()) out.push(`${path}@`);
    else
      out.push(
        `${path} ${createHash('sha256')
          .update(readFileSync(join(dir, path)))
          .digest('hex')}`,
      );
  }
  return out.sort();
}

/** Streams go to files: `process.exit` drops what a pipe has not taken, so the oracle's output past
 * 64 KiB never reaches a pipe at all. */
function run(program: string, args: readonly string[], dir: string): Promise<Outcome> {
  const env = { ...process.env };
  delete env['CC'];
  const outPath = `${dir}.stdout`;
  const errPath = `${dir}.stderr`;
  const out = openSync(outPath, 'w');
  const err = openSync(errPath, 'w');
  return new Promise((done, fail) => {
    const child = spawn(program, args, { cwd: dir, env, stdio: ['ignore', out, err] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', fail);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      closeSync(out);
      closeSync(err);
      done({
        code,
        signal,
        stdout: readFileSync(outPath, 'latin1'),
        stderr: readFileSync(errPath, 'latin1'),
        left: listing(dir),
      });
    });
  });
}

const CRASH =
  /panic|Segmentation|STA4\d\d\d|reached unreachable|integer overflow|index out of bounds|attempt to use null/;

/** An uncaught exception of the oracle prints a stack: an oracle bug, kept apart from a difference. */
const ORACLE_CRASH = /^\s+at .*\.ts:\d+:\d+|RangeError|node:internal/m;

interface Tally {
  identical: number;
  different: number;
  /** Differs on a `--diff` file with a syntax error: two parsers' recovery, never a valid binding. */
  recovery: number;
  crashed: number;
  oracleCrashed: number;
}

function line(row: Tally): string {
  return `${row.identical} identical, ${row.different} different, ${row.recovery} different after a syntax error, ${row.crashed} crashed, ${row.oracleCrashed} oracle crashed`;
}

/** Whether the case's `--diff` file parses clean, by the parser the oracle uses. */
function hasSyntaxError(c: Case): boolean {
  const name = c.args.find((arg) => arg.startsWith('--diff='))?.slice('--diff='.length);
  const content = name === undefined ? undefined : c.files[name];
  if (name === undefined || content === undefined) return false;
  const text = Buffer.from(content).toString('utf8');
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true) as unknown as {
    readonly parseDiagnostics: readonly unknown[];
  };
  return source.parseDiagnostics.length > 0;
}

interface Difference {
  readonly c: Case;
  readonly oracle: Outcome;
  readonly zig: Outcome;
}

async function main(): Promise<void> {
  const inline = inlineInputs();
  const headers = [...trackedHeaders(), ...inline.headers];
  const hand = [...handFiles(), ...inline.hand];
  const sources = trackedSources();
  const rng = new Rng(SEED);
  const cases = [
    ...argumentCases(),
    ...realCases(headers, hand),
    ...sourceCases(sources),
    ...stressCases(),
    ...deepCases(),
    ...mutatedHeaders(headers, rng),
    ...mutatedHand(headers, hand, rng),
    ...mutatedDumps(headers, rng),
  ].filter((c) => ONLY === undefined || c.group === ONLY);
  process.stderr.write(
    `inputs: ${headers.length} headers, ${sources.length} C sources, ${hand.length} bindings; ${cases.length} cases\n`,
  );

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ffigen-parity-')));
  const tally = new Map<string, Tally>();
  const differences: Difference[] = [];
  const crashes: Difference[] = [];
  const oracleCrashes: Difference[] = [];
  const recovered: Difference[] = [];
  let next = 0;
  const worker = async (id: number): Promise<void> => {
    const dir = join(root, `w${id}`, 'case');
    while (next < cases.length) {
      const c = cases[next];
      next += 1;
      if (c === undefined) return;
      prepare(dir, c);
      const oracle = await run(process.execPath, [ORACLE, ...c.args], dir);
      prepare(dir, c);
      const zig = await run(ZIG, ['ffi-gen', ...c.args], dir);
      const row = tally.get(c.group) ?? {
        identical: 0,
        different: 0,
        recovery: 0,
        crashed: 0,
        oracleCrashed: 0,
      };
      tally.set(c.group, row);
      const zigCrashed = zig.signal !== null || CRASH.test(zig.stderr);
      if (zigCrashed) {
        row.crashed += 1;
        crashes.push({ c, oracle, zig });
      } else if (
        oracle.code === zig.code &&
        oracle.stdout === zig.stdout &&
        oracle.stderr === zig.stderr &&
        oracle.left.join('\n') === zig.left.join('\n')
      ) {
        row.identical += 1;
      } else if (oracle.signal !== null || ORACLE_CRASH.test(oracle.stderr)) {
        row.oracleCrashed += 1;
        oracleCrashes.push({ c, oracle, zig });
      } else if (hasSyntaxError(c)) {
        row.recovery += 1;
        recovered.push({ c, oracle, zig });
      } else {
        row.different += 1;
        differences.push({ c, oracle, zig });
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, (_, id) => worker(id)));

  const describe = ({ c, oracle, zig }: Difference): string => {
    const parts = [`--- [${c.group}] ${c.name}: ${c.args.join(' ')}`];
    if (oracle.code !== zig.code || oracle.signal !== zig.signal)
      parts.push(`code oracle=${oracle.code}/${oracle.signal} zig=${zig.code}/${zig.signal}`);
    for (const stream of ['stdout', 'stderr'] as const) {
      const left = oracle[stream];
      const right = zig[stream];
      if (left === right) continue;
      let at = 0;
      while (at < left.length && left[at] === right[at]) at += 1;
      parts.push(
        `${stream} at ${at}:\n  oracle: ${JSON.stringify(left.slice(Math.max(0, at - 80), at + 160))}\n  zig:    ${JSON.stringify(right.slice(Math.max(0, at - 80), at + 160))}`,
      );
    }
    if (oracle.left.join('\n') !== zig.left.join('\n'))
      parts.push(`files oracle=${oracle.left.length} zig=${zig.left.length}`);
    return parts.join('\n');
  };
  for (const item of crashes.slice(0, SHOW))
    process.stdout.write(`CRASH ${describe(item)}\n${item.zig.stderr.slice(0, 600)}\n`);
  for (const item of differences.slice(0, SHOW)) process.stdout.write(`${describe(item)}\n`);
  if (flag('show-recovery') !== undefined) {
    for (const item of recovered.slice(0, SHOW))
      process.stdout.write(`RECOVERY ${describe(item)}\n`);
  }
  for (const { c, oracle, zig } of oracleCrashes.slice(0, SHOW)) {
    process.stdout.write(
      `ORACLE CRASH [${c.group}] ${c.name}: oracle ${oracle.code}/${oracle.signal}, zig ${zig.code}/${zig.signal}\n${oracle.stderr.slice(0, 300)}\n`,
    );
  }
  const keep = flag('keep');
  if (keep !== undefined) {
    for (const [index, item] of [...crashes, ...differences, ...recovered].entries()) {
      const dir = join(keep, `${item.c.group}-${index}`);
      prepare(dir, item.c);
      writeFileSync(join(dir, 'ARGS'), `${item.c.args.join('\n')}\n`);
    }
  }
  rmSync(root, { recursive: true, force: true });

  const total = { identical: 0, different: 0, recovery: 0, crashed: 0, oracleCrashed: 0 };
  for (const [group, row] of [...tally].sort(([l], [r]) => (l < r ? -1 : l > r ? 1 : 0))) {
    process.stdout.write(`${group}: ${line(row)}\n`);
    total.identical += row.identical;
    total.different += row.different;
    total.recovery += row.recovery;
    total.crashed += row.crashed;
    total.oracleCrashed += row.oracleCrashed;
  }
  process.stdout.write(`total: ${line(total)}\n`);
  process.exitCode = total.different === 0 && total.recovery === 0 && total.crashed === 0 ? 0 : 1;
}

await main();
