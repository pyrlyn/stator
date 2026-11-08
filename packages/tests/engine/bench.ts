/* V8 against the stator engine (plan/T67): the bench programs under the pinned Node and under
 * `stator-engine run` in `interp` and `jit` mode, built ReleaseFast.
 *
 *   node packages/tests/engine/bench.ts [--runs=N]
 *
 * Every run's stdout must equal Node's; a mismatch fails the run rather than reporting a time for
 * a wrong answer. Times are wall clock from spawn to exit (startup included), best of N; peak RSS
 * is the largest seen. Results go to engine/results/ (ignored) and the table to stdout, with the
 * host, versions and flags they hold for. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, hostname, platform, release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePath } from '../support/node-path.ts';
import { timedRun } from '../support/timed-run.ts';
import { engineBinary } from './binary.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..', 'bench');
const PROGRAMS = [
  join(BENCH, 'programs', 'fib.ts'),
  join(BENCH, 'programs', 'nbody.ts'),
  join(BENCH, 'programs', 'string-churn.ts'),
  join(BENCH, 'programs', 'json-roundtrip.ts'),
  join(BENCH, 'memory', 'programs', 'hello.ts'),
  join(BENCH, 'memory', 'programs', 'objects-churn.ts'),
  join(BENCH, 'memory', 'programs', 'objects-retained.ts'),
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

const engine = engineBinary('ReleaseFast');
const node = nodePath();
const tools: readonly Tool[] = [
  { name: 'node (V8)', command: node, args: [] },
  { name: 'engine interp', command: engine, args: ['run', '--mode=interp'] },
  { name: 'engine jit', command: engine, args: ['run', '--mode=jit'] },
];

function measure(tool: Tool, program: string, expected: string): Measurement {
  let ms = Number.POSITIVE_INFINITY;
  let rss = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const r = timedRun(tool.command, [...tool.args, program], { timeout: 600_000 });
    if (r.status !== 0 || r.stdout !== expected) {
      throw new Error(
        `${tool.name} on ${basename(program)}: exit ${String(r.status)}, stdout ${JSON.stringify(r.stdout.slice(0, 200))}, want ${JSON.stringify(expected.slice(0, 200))}\n${r.stderr}`,
      );
    }
    ms = Math.min(ms, r.ms);
    rss = Math.max(rss, r.maxRssBytes);
  }
  return { ms, rssMb: rss / (1 << 20) };
}

const rows = PROGRAMS.map((program) => {
  const expected = timedRun(node, [program]).stdout;
  return {
    program: basename(program, '.ts'),
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
const lines = [
  `Recorded ${new Date().toISOString()} on ${host.cpu} (${host.os}, ${host.arch}); Node ${host.node}, Zig ${host.zig}, engine ${host.engineBuild}; best of ${String(RUNS)}, wall ms incl. startup.`,
  '',
  `| program | ${tools.map((t) => `${t.name} ms`).join(' | ')} | jit vs V8 | ${tools.map((t) => `${t.name} MB`).join(' | ')} |`,
  `|---|${tools.map(() => '---:').join('|')}|---:|${tools.map(() => '---:').join('|')}|`,
  ...rows.map((r) => {
    const v8 = r.results[0]?.ms ?? Number.NaN;
    const jit = r.results[2]?.ms ?? Number.NaN;
    return `| ${r.program} | ${r.results.map((m) => fmt(m.ms)).join(' | ')} | ${(jit / v8).toFixed(2)}x | ${r.results.map((m) => fmt(m.rssMb)).join(' | ')} |`;
  }),
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
