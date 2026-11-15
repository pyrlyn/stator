/* V8 against the stator engine's JIT (plan/T67, plan/T67.1): the TypeScript bench programs and
 * the JavaScript ones in engine/bench/ under the pinned Node and under `stator-engine run
 * --mode=jit`, built ReleaseFast. V8 is the only reference: the goal is to beat it.
 *
 *   node packages/tests/engine/bench.ts [--runs=N]
 *
 * Every run's stdout must equal Node's. A wrong answer never gets a time: V8 failing aborts the
 * run, and a program the engine cannot run yet is a ✗ in its cell with the reason under the
 * table, so one missing builtin does not hide the rest of the measurement. Times are wall clock from spawn to exit (startup included), best of N; peak RSS
 * is the largest seen. Results go to engine/results/ (ignored) and the table to stdout, with the
 * host, versions and flags they hold for. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, hostname, platform, release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchPrograms, engineAgnostic } from '../support/bench-programs.ts';
import { nodePath } from '../support/node-path.ts';
import { timedRun } from '../support/timed-run.ts';
import { engineBinary } from './binary.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..', 'bench');
const PROGRAMS = [
  ...benchPrograms()
    .filter((p) => p.mode === 'ts' && engineAgnostic(p))
    .map((p) => p.path),
  join(BENCH, 'memory', 'programs', 'hello.ts'),
  join(BENCH, 'memory', 'programs', 'objects-churn.ts'),
  join(BENCH, 'memory', 'programs', 'objects-retained.ts'),
  ...benchPrograms()
    .filter((p) => p.mode === 'js')
    .map((p) => p.path),
];

const runsFlag = process.argv.find((a) => a.startsWith('--runs='));
const RUNS = runsFlag === undefined ? 5 : Number.parseInt(runsFlag.slice('--runs='.length), 10);
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error(`bad --runs: ${String(runsFlag)}`);

interface Tool {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

interface Measurement {
  readonly ms: number;
  readonly rssMb: number;
}

interface Failure {
  readonly failed: string;
}

const engine = engineBinary('ReleaseFast');
const node = nodePath();
const tools: readonly Tool[] = [
  { name: 'node (V8)', command: node, args: [] },
  { name: 'engine jit', command: engine, args: ['run', '--mode=jit'] },
];

function measure(tool: Tool, program: string, expected: string): Measurement | Failure {
  let ms = Number.POSITIVE_INFINITY;
  let rss = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const r = timedRun(tool.command, [...tool.args, program], { timeout: 600_000 });
    if (r.status !== 0 || r.stdout !== expected) {
      const why = `exit ${String(r.status)}, stdout ${JSON.stringify(r.stdout.slice(0, 200))}, want ${JSON.stringify(expected.slice(0, 200))}\n${r.stderr}`;
      if (tool === tools[0]) throw new Error(`${tool.name} on ${basename(program)}: ${why}`);
      return { failed: r.stderr.trim().split('\n')[0] ?? `exit ${String(r.status)}` };
    }
    ms = Math.min(ms, r.ms);
    rss = Math.max(rss, r.maxRssBytes);
  }
  return { ms, rssMb: rss / (1 << 20) };
}

const rows = PROGRAMS.map((program) => {
  const expected = timedRun(node, [program]).stdout;
  return {
    program: basename(program),
    results: tools.map((t) => measure(t, program, expected)),
  };
});

const zigVersion = execFileSync('zig', ['version'], { encoding: 'utf8' }).trim();
const host = {
  cpu: cpus()[0]?.model ?? 'unknown',
  os: `${platform()} ${release()}`,
  arch: arch(),
  node: execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(),
  zig: zigVersion,
  engineBuild: 'ReleaseFast',
  runs: RUNS,
};

const fmt = (n: number): string => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
const cell = (m: Measurement | Failure | undefined, value: (m: Measurement) => string): string =>
  m === undefined || 'failed' in m ? '✗' : value(m);
const ratio = (
  jit: Measurement | Failure | undefined,
  v8: Measurement | Failure | undefined,
): string =>
  jit === undefined || v8 === undefined || 'failed' in jit || 'failed' in v8
    ? '—'
    : `${(jit.ms / v8.ms).toFixed(2)}x`;
const failures = rows.flatMap((r) =>
  r.results.flatMap((m, i) =>
    'failed' in m ? [`- ${r.program} under ${tools[i]?.name ?? '?'}: ${m.failed}`] : [],
  ),
);
const lines = [
  `Recorded ${new Date().toISOString()} on ${host.cpu} (${host.os}, ${host.arch}); Node ${host.node}, Zig ${host.zig}, engine ${host.engineBuild}; best of ${String(RUNS)}, wall ms incl. startup.`,
  '',
  `| program | ${tools.map((t) => `${t.name} ms`).join(' | ')} | jit vs V8 | ${tools.map((t) => `${t.name} MB`).join(' | ')} |`,
  `|---|${tools.map(() => '---:').join('|')}|---:|${tools.map(() => '---:').join('|')}|`,
  ...rows.map(
    (r) =>
      `| ${r.program} | ${r.results.map((m) => cell(m, (x) => fmt(x.ms))).join(' | ')} | ${ratio(r.results[1], r.results[0])} | ${r.results.map((m) => cell(m, (x) => fmt(x.rssMb))).join(' | ')} |`,
  ),
  ...(failures.length === 0 ? [] : ['', `Not run yet (${String(failures.length)}):`, ...failures]),
];
process.stdout.write(`${lines.join('\n')}\n`);

const out = join(HERE, 'results');
mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(
  out,
  `${stamp}-${platform()}-${arch()}-${hostname()}.json`.replace(/[^A-Za-z0-9_./-]/g, '_'),
);
writeFileSync(
  file,
  `${JSON.stringify({ host, tools: tools.map((t) => t.name), rows }, null, 2)}\n`,
);
process.stdout.write(`wrote ${file}\n`);
