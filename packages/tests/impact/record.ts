/* Record the test impact map (plan.md §9 Task 6.17, plan-notes 293).
 *
 * Usage: node packages/tests/impact/record.ts [--out=<path>] [--jobs=N] [--harness=a,b]
 *        (`pnpm run test:impact:record`)
 *
 * A full run of every harness, instrumented, on a clean tree: the map it writes is keyed to
 * `HEAD`, this Node and this platform, and the selector trusts it only for descendants of that
 * commit. Nothing is written when a test fails — a failing test's coverage stops where it failed,
 * so a map recorded on red would under-select exactly the code that broke.
 *
 * - **subset, golden, asan** (in-process): `--shard=i/N` workers, each one wide, under the
 *   preload's precise coverage — one take after loading, one per fixture. `asan` is the golden
 *   runner against the sanitized archive, which is `test:asan`'s third stage.
 * - **unit** (per process): each test file alone under `NODE_V8_COVERAGE`, which also covers the
 *   CLI processes the tests spawn; the preload rides `NODE_OPTIONS` for reads and links.
 * - **leak, ffi, builtins**: the same, one key each. **runtime** (`just runtime-test`, no
 *   TypeScript) is recorded as depending on the whole runtime.
 */
import { spawnSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAP_SCHEMA,
  encodeBits,
  isHarnessName,
  type HarnessName,
  type HarnessRecord,
  type ImpactMap,
  type Span,
  type TestRecord,
} from '../support/impact.ts';
import { pool, readShardFile, runProcess } from '../support/parallel.ts';
import { CoverageConverter } from './coverage.ts';
import type { RawHarness } from './recorder.ts';
import {
  ASAN_ENV,
  DEFAULT_MAP,
  PLATFORM,
  PRELOAD,
  REPO,
  RUNNERS,
  UNIT_DIR,
  VITEST,
  VITEST_CONFIG,
  archiveCommands,
  currentTests,
  git,
  justCommand,
  type Command,
} from './shared.ts';

/* ---------------------------------------------------------------------------------------- */
/* Merge: raw per-process records → one harness record                                      */
/* ---------------------------------------------------------------------------------------- */

const spanKey = (span: Span): string => `${String(span[0])}:${String(span[1])}`;

class HarnessBuilder {
  readonly files = new Map<string, { all: Set<string>; loadTime: Set<string> }>();
  readonly loaded = new Set<string>();
  readonly reads = new Set<string>();
  readonly tests = new Map<
    string,
    {
      spans: Map<string, Set<string>>;
      loaded: Set<string>;
      reads: Set<string>;
      native: Set<string>;
    }
  >();

  file(path: string): { all: Set<string>; loadTime: Set<string> } {
    let file = this.files.get(path);
    if (file === undefined) {
      file = { all: new Set(), loadTime: new Set() };
      this.files.set(path, file);
    }
    return file;
  }

  test(key: string): {
    spans: Map<string, Set<string>>;
    loaded: Set<string>;
    reads: Set<string>;
    native: Set<string>;
  } {
    let test = this.tests.get(key);
    if (test === undefined) {
      test = { spans: new Map(), loaded: new Set(), reads: new Set(), native: new Set() };
      this.tests.set(key, test);
    }
    return test;
  }

  addRaw(raw: RawHarness): void {
    for (const [path, file] of Object.entries(raw.files)) {
      const into = this.file(path);
      for (const span of file.all) into.all.add(spanKey(span));
      for (const span of file.loadTime) into.loadTime.add(spanKey(span));
    }
    for (const path of raw.loaded) this.loaded.add(path);
    for (const path of raw.reads) this.reads.add(path);
    for (const test of raw.tests) {
      const into = this.test(test.key);
      for (const [path, spans] of Object.entries(test.spans)) {
        const set = into.spans.get(path) ?? new Set<string>();
        into.spans.set(path, set);
        for (const span of spans) {
          set.add(spanKey(span));
          this.file(path).all.add(spanKey(span));
        }
      }
      for (const path of test.reads) into.reads.add(path);
      for (const path of test.native) into.native.add(path);
    }
  }

  /** One per-process test: every coverage file and every `impact-*.txt` under `dir`. */
  addProcessDir(key: string, dir: string, converter: CoverageConverter): void {
    const test = this.test(key);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.startsWith('coverage-') && name.endsWith('.json')) {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const result: unknown =
          typeof parsed === 'object' && parsed !== null && 'result' in parsed ? parsed.result : [];
        const snap = converter.convert(Array.isArray(result) ? (result as unknown[]) : []);
        for (const file of snap.files) {
          const into = this.file(file.path);
          for (const span of file.all) into.all.add(spanKey(span));
          if (file.rootRan) test.loaded.add(file.path);
          if (file.executed.length > 0) {
            const set = test.spans.get(file.path) ?? new Set<string>();
            test.spans.set(file.path, set);
            for (const span of file.executed) set.add(spanKey(span));
          }
        }
        for (const name2 of snap.packages) test.loaded.add(name2);
      } else if (name.startsWith('impact-') && name.endsWith('.txt')) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (line.startsWith('R ')) test.reads.add(line.slice(2));
          else if (line.startsWith('N ')) test.native.add(line.slice(2));
        }
      }
    }
  }

  build(): HarnessRecord {
    const files: Record<string, { fns: Span[]; loadTime: number[] }> = {};
    const indexOf = new Map<string, Map<string, number>>();
    for (const [path, file] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
      const fns = [...file.all]
        .map((key): Span => {
          const [first, last] = key.split(':');
          return [Number(first), Number(last)];
        })
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const index = new Map(fns.map((span, at) => [spanKey(span), at]));
      indexOf.set(path, index);
      files[path] = {
        fns,
        loadTime: [...file.loadTime]
          .map((key) => index.get(key) ?? -1)
          .filter((at) => at >= 0)
          .sort((a, b) => a - b),
      };
    }
    // A module file the loader read is code, not data: coverage already covers it.
    const isModule = (path: string, loaded: ReadonlySet<string>): boolean =>
      this.loaded.has(path) || loaded.has(path);
    const tests: Record<string, TestRecord> = {};
    for (const [key, test] of [...this.tests].sort(([a], [b]) => a.localeCompare(b))) {
      const fns: Record<string, string> = {};
      for (const [path, spans] of [...test.spans].sort(([a], [b]) => a.localeCompare(b))) {
        const index = indexOf.get(path);
        const size = files[path]?.fns.length ?? 0;
        if (index === undefined) continue;
        fns[path] = encodeBits(
          [...spans].map((span) => index.get(span) ?? -1).filter((at) => at >= 0),
          size,
        );
      }
      const reads = [...test.reads].filter((path) => !isModule(path, test.loaded)).sort();
      const native = test.native.has('*') ? ['*'] : [...test.native].sort();
      tests[key] = {
        fns,
        ...(test.loaded.size > 0 ? { loaded: [...test.loaded].sort() } : {}),
        ...(reads.length > 0 ? { reads } : {}),
        ...(native.length > 0 ? { native } : {}),
      };
    }
    return {
      files,
      loaded: [...this.loaded].sort(),
      reads: [...this.reads].filter((path) => !isModule(path, new Set())).sort(),
      tests,
    };
  }
}

/* ---------------------------------------------------------------------------------------- */
/* Orchestration                                                                            */
/* ---------------------------------------------------------------------------------------- */

interface Options {
  readonly out: string;
  readonly jobs: number;
  readonly harnesses: readonly HarnessName[];
}

function parseArgs(argv: readonly string[]): Options {
  let out = DEFAULT_MAP;
  let jobs = availableParallelism();
  let harnesses: HarnessName[] = [
    'subset',
    'golden',
    'asan',
    'unit',
    'leak',
    'ffi',
    'builtins',
    'node-coverage',
    'runtime',
  ];
  for (const arg of argv) {
    if (arg.startsWith('--out=')) out = resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--jobs=')) jobs = Math.max(1, Number.parseInt(arg.slice(7), 10) || 1);
    else if (arg.startsWith('--harness=')) {
      harnesses = arg
        .slice('--harness='.length)
        .split(',')
        .map((name) => {
          if (!isHarnessName(name)) throw new Error(`unknown harness "${name}"`);
          return name;
        });
    } else {
      throw new Error(`unknown flag "${arg}"`);
    }
  }
  return { out, jobs, harnesses };
}

function runInherited(command: Command): void {
  const result = spawnSync(command.command, [...command.args], {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, ...command.env },
  });
  if (result.status !== 0)
    throw new Error(`${command.label} failed (exit ${String(result.status)})`);
}

/** In-process harnesses: N one-wide shard workers under the preload; returns failing keys. */
async function recordInProcess(
  harness: 'subset' | 'golden' | 'asan',
  tmp: string,
  jobs: number,
  builder: HarnessBuilder,
): Promise<string[]> {
  const runner = harness === 'subset' ? RUNNERS.subset : RUNNERS.golden;
  const rawDir = join(tmp, harness);
  const env = {
    ...process.env,
    ...(harness === 'asan' ? ASAN_ENV : {}),
    STATOR_IMPACT_RECORD: rawDir,
    STATOR_IMPACT_INPROC: '1',
    STATOR_TEST_JOBS: '1',
  };
  const runs = await Promise.all(
    Array.from({ length: jobs }, async (_unused, slot) => {
      const out = join(tmp, `${harness}-result-${String(slot + 1)}.json`);
      const result = await runProcess(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          '--import',
          pathToFileURL(PRELOAD).href,
          join(REPO, runner),
          `--shard=${String(slot + 1)}/${String(jobs)}`,
          `--json-out=${out}`,
        ],
        { env },
      );
      if (result.status !== 0) {
        throw new Error(
          `${harness} shard ${String(slot + 1)} exited ${String(result.status)}: ${result.stderr.trim()}`,
        );
      }
      return out;
    }),
  );
  const failures: string[] = [];
  for (const out of runs) {
    for (const record of readShardFile(out)) {
      const value = record.value;
      const passed =
        value === null ||
        (typeof value === 'object' &&
          'kind' in value &&
          (value.kind === 'passed' || value.kind === 'expected-fail'));
      if (!passed) failures.push(record.key);
    }
  }
  for (const name of readdirSync(rawDir)) {
    if (name.endsWith('.raw.json')) {
      builder.addRaw(JSON.parse(readFileSync(join(rawDir, name), 'utf8')) as RawHarness);
    }
  }
  return failures;
}

/** One per-process test: its command under `NODE_V8_COVERAGE` with the preload in
 * `NODE_OPTIONS`, so every Node process it starts is covered. Returns whether it passed. */
async function recordProcess(
  key: string,
  command: Command,
  dir: string,
  builder: HarnessBuilder,
  converter: CoverageConverter,
): Promise<boolean> {
  mkdirSync(dir, { recursive: true });
  const preload = `--import=${pathToFileURL(PRELOAD).href}`;
  const result = await runProcess(command.command, command.args, {
    env: {
      ...process.env,
      ...command.env,
      NODE_V8_COVERAGE: dir,
      STATOR_IMPACT_RECORD: dir,
      NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} ${preload}`.trim(),
    },
  });
  builder.addProcessDir(key, dir, converter);
  rmSync(dir, { recursive: true, force: true });
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout}${result.stderr}`);
  }
  return result.status === 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // Every spawned harness resolves its paths (and vitest its config) from the repo root.
  process.chdir(REPO);
  const started = Date.now();
  const commit = git(['rev-parse', 'HEAD']).trim();
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).trim() !== '';
  if (dirty) {
    process.stderr.write(
      'impact: the tree has uncommitted changes — the map will be marked dirty and the selector will not trust it\n',
    );
  }
  for (const command of archiveCommands()) runInherited(command);
  if (options.harnesses.includes('asan')) runInherited(justCommand('runtime-asan'));

  const tmp = mkdtempSync(join(tmpdir(), 'stator-impact-'));
  const harnesses: Partial<Record<HarnessName, HarnessRecord>> = {};
  const failures: string[] = [];
  const converter = new CoverageConverter(REPO);
  const current = currentTests();
  try {
    for (const harness of options.harnesses) {
      const t0 = Date.now();
      const builder = new HarnessBuilder();
      switch (harness) {
        case 'subset':
        case 'golden':
        case 'asan':
          for (const key of await recordInProcess(harness, tmp, options.jobs, builder)) {
            failures.push(`${harness}: ${key}`);
          }
          break;
        case 'unit': {
          const passed = await pool(
            current.unit,
            async (file, slot) =>
              recordProcess(
                file,
                { label: file, command: VITEST, args: ['run', '--config', VITEST_CONFIG, file] },
                join(tmp, 'unit', `${String(slot)}-${file.slice(UNIT_DIR.length + 1)}`),
                builder,
                converter,
              ),
            Math.max(1, Math.floor(options.jobs / 2)),
          );
          current.unit.forEach((file, at) => {
            if (passed[at] !== true) failures.push(`unit: ${file}`);
          });
          break;
        }
        case 'leak':
        case 'ffi':
        case 'builtins':
        case 'node-coverage': {
          const script = join(REPO, RUNNERS[harness]);
          const args = harness === 'node-coverage' ? ['--check'] : [];
          const ok = await recordProcess(
            harness,
            { label: harness, command: process.execPath, args: [script, ...args] },
            join(tmp, harness),
            builder,
            converter,
          );
          if (!ok) failures.push(harness);
          break;
        }
        case 'runtime':
          // `just runtime-test`: C and the print_*.ts oracles — the whole runtime.
          builder.test('runtime').native.add('*');
          break;
        default: {
          const exhaustive: never = harness;
          throw new Error(`unhandled harness ${String(exhaustive)}`);
        }
      }
      harnesses[harness] = builder.build();
      process.stdout.write(
        `impact: recorded ${harness} — ${String(builder.tests.size)} tests in ${String(Math.round((Date.now() - t0) / 1000))} s\n`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
    throw new Error(
      `${String(failures.length)} test(s) failed — no map written (a red run under-records)`,
    );
  }
  const map: ImpactMap = {
    schema: MAP_SCHEMA,
    commit,
    dirty,
    node: process.version,
    platform: PLATFORM,
    recordedAt: new Date().toISOString(),
    harnesses,
  };
  mkdirSync(dirname(options.out), { recursive: true });
  const partial = `${options.out}.tmp`;
  writeFileSync(partial, `${JSON.stringify(map)}\n`, 'utf8');
  renameSync(partial, options.out);
  process.stdout.write(
    `impact: map for ${commit.slice(0, 12)} written to ${options.out} in ${String(Math.round((Date.now() - started) / 1000))} s\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`impact: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
