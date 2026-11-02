// Compares what the TS compiler and statorc-zig load for each entry of the corpus: the source
// files, the module order and the frontend's diagnostics. Run on the pinned Node after `zig build`
// in `packages/compiler-zig`:
//   node packages/tests/zigdiff/program.ts [substring] [--show=<n>]
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as ts from 'typescript';
import { loadFrontend } from '../../compiler/src/cli/bundler.ts';
import { moduleOrder } from '../../compiler/src/frontend/graph.ts';
import { corpusFixtures } from '../support/corpus.ts';

const TESTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(TESTS, '..', '..');
const BINARY = join(REPO, 'packages', 'compiler-zig', 'zig-out', 'bin', 'statorc-zig');

interface Reported {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly class: string;
  readonly message: string;
}

interface Dump {
  readonly files: readonly string[];
  readonly libs: readonly string[];
  readonly order: readonly string[];
  readonly diagnostics: readonly Reported[];
  readonly parse: readonly Reported[];
}

interface Entry {
  readonly key: string;
  readonly path: string;
  readonly mode: 'ts' | 'js';
  readonly node: boolean;
}

function exampleEntries(): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/(?<!\.d)\.ts$/.test(name)) add(path, 'ts');
      else if (name.endsWith('.js')) add(path, 'js');
    }
  };
  const add = (path: string, mode: 'ts' | 'js'): void => {
    out.push({
      key: `examples/${relative(join(REPO, 'examples'), path)}:${mode}`,
      path,
      mode,
      node: false,
    });
    out.push({
      key: `examples/${relative(join(REPO, 'examples'), path)}:js`,
      path,
      mode: 'js',
      node: true,
    });
  };
  walk(join(REPO, 'examples'));
  return [...new Map(out.map((entry) => [`${entry.key}${String(entry.node)}`, entry])).values()];
}

function reported(d: {
  file: string;
  line: number;
  column: number;
  code: string;
  class: string;
  message: string;
}): Reported {
  return {
    file: d.file,
    line: d.line,
    column: d.column,
    code: d.code,
    class: d.class,
    message: d.message,
  };
}

function isLibrary(program: ts.Program, file: ts.SourceFile): boolean {
  return program.isSourceFileDefaultLibrary(file);
}

async function oracleAsync(entry: Entry): Promise<Dump | string> {
  try {
    const frontend = await loadFrontend(entry.path, entry.mode, { kind: 'none' }, entry.node);
    const { program } = frontend;
    const files = program.getSourceFiles();
    const entryFile = program.getSourceFile(entry.path);
    const order = entryFile === undefined ? [] : moduleOrder(program, entryFile, entry.mode);
    return {
      files: files
        .filter((f) => !isLibrary(program, f))
        .map((f) => f.fileName)
        .sort(),
      libs: files
        .filter((f) => isLibrary(program, f))
        .map((f) => f.fileName)
        .sort(),
      order: Array.isArray(order) ? [] : order.order.map((f) => f.fileName),
      diagnostics: [
        ...frontend.diagnostics.map(reported),
        ...(Array.isArray(order) ? [] : order.diagnostics.map(reported)),
      ],
      parse: frontend.parseDiagnostics.map(reported),
    };
  } catch (error) {
    return `oracle threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function zig(entry: Entry): Dump | string {
  try {
    const text = execFileSync(
      BINARY,
      ['dump-program', entry.path, entry.mode, entry.node ? 'node' : 'plain'],
      {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return JSON.parse(text) as Dump;
  } catch (error) {
    return `zig failed: ${error instanceof Error ? error.message.slice(0, 400) : String(error)}`;
  }
}

function sameList(l: readonly unknown[], r: readonly unknown[]): boolean {
  return JSON.stringify(l) === JSON.stringify(r);
}

function bySite(l: Reported, r: Reported): number {
  return (
    (l.file < r.file ? -1 : l.file > r.file ? 1 : 0) ||
    l.line - r.line ||
    l.column - r.column ||
    (l.code < r.code ? -1 : l.code > r.code ? 1 : 0) ||
    (l.message < r.message ? -1 : l.message > r.message ? 1 : 0)
  );
}

const filter = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const show = Number(
  process.argv.find((arg) => arg.startsWith('--show='))?.slice('--show='.length) ?? 20,
);
const entries: Entry[] = [...corpusFixtures(TESTS), ...exampleEntries()].filter(
  (entry) => filter === undefined || entry.key.includes(filter),
);

const tally = { entries: 0, files: 0, libs: 0, order: 0, diagnostics: 0, parse: 0, failed: 0 };
const misses: string[] = [];
for (const entry of entries) {
  tally.entries += 1;
  const want = await oracleAsync(entry);
  const got = zig(entry);
  if (typeof want === 'string' || typeof got === 'string') {
    tally.failed += 1;
    misses.push(
      `${entry.key}: ${typeof want === 'string' ? want : ''} ${typeof got === 'string' ? got : ''}`,
    );
    continue;
  }
  const check = (
    name: 'files' | 'libs' | 'order',
    l: readonly string[],
    r: readonly string[],
  ): void => {
    if (sameList(l, r)) tally[name] += 1;
    else {
      const missing = l.filter((x) => !r.includes(x)).slice(0, 3);
      const extra = r.filter((x) => !l.includes(x)).slice(0, 3);
      misses.push(
        `${entry.key}: ${name} differ: only oracle ${JSON.stringify(missing)}, only zig ${JSON.stringify(extra)}`,
      );
    }
  };
  check('files', want.files, got.files);
  check('libs', want.libs, got.libs);
  check('order', want.order, got.order);
  const compare = (
    name: 'diagnostics' | 'parse',
    l: readonly Reported[],
    r: readonly Reported[],
  ): void => {
    const sortedL = [...l].sort(bySite);
    const sortedR = [...r].sort(bySite);
    if (sameList(sortedL, sortedR)) {
      tally[name] += 1;
      return;
    }
    const index = sortedL.findIndex((d, i) => JSON.stringify(d) !== JSON.stringify(sortedR[i]));
    misses.push(
      `${entry.key}: ${name} differ (${sortedL.length} vs ${sortedR.length}): oracle ${JSON.stringify(sortedL[index] ?? null)} zig ${JSON.stringify(sortedR[index === -1 ? sortedL.length : index] ?? null)}`,
    );
  };
  compare('diagnostics', want.diagnostics, got.diagnostics);
  compare('parse', want.parse, got.parse);
}
for (const miss of misses.slice(0, show)) console.log(miss);
console.log(JSON.stringify({ ...tally, misses: misses.length }));
process.exitCode = misses.length === 0 ? 0 : 1;
