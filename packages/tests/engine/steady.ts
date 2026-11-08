/* T69: warmed execution, distinct from bench.ts's cold process measurements. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { arch, cpus, hostname, loadavg, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePath } from '../support/node-path.ts';
import { timedRun } from '../support/timed-run.ts';
import { engineBinary, REPO } from './binary.ts';
import {
  measuredGc,
  measuredV8Gc,
  nodeGcClock,
  parseSteady,
  percentile,
  steadyDriver,
} from './steady-protocol.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = join(HERE, 'scripts', 'steady');
const out = join(HERE, 'results', `steady-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(out, { recursive: true });
let rounds = 3;
for (const arg of process.argv.slice(2)) {
  if (!/^--rounds=[1-9][0-9]*$/.test(arg)) throw new Error(`unknown option: ${arg}`);
  rounds = Number(arg.slice('--rounds='.length));
  if (!Number.isSafeInteger(rounds) || rounds > 100) throw new Error('rounds must be 1..100');
}
const node = nodePath();
const engine = engineBinary('ReleaseFast', 'steady');
const env = {
  ...process.env,
  NODE_OPTIONS: '',
  JSRT_GC_TRACE: '0',
  JSRT_GC_VERIFY: '0',
  JSRT_GC_STRESS: '0',
  STATOR_JIT_TRACE: '0',
};
const tools = [
  { name: 'V8', command: node, args: ['--require', join(out, 'clock.cjs')] },
  { name: 'Stator JIT', command: engine, args: [] },
] as const;
writeFileSync(join(out, 'clock.cjs'), 'globalThis.__benchNow = () => performance.now();\n');
writeFileSync(join(out, 'gc-clock.cjs'), nodeGcClock);
const version = (command: string, args: readonly string[]): string =>
  execFileSync(command, args, { encoding: 'utf8', cwd: REPO, env }).trim();
const metadata = {
  commit: version('git', ['rev-parse', 'HEAD']),
  dirty: version('git', ['status', '--porcelain']),
  cpu: cpus()[0]?.model ?? 'unknown',
  host: hostname(),
  platform: platform(),
  arch: arch(),
  os: release(),
  loadBefore: loadavg(),
  node: version(node, ['--version']),
  v8: version(node, ['-p', 'process.versions.v8']),
  zig: version('zig', ['version']),
  build: process.env['STATOR_STEADY'] ? 'external (unverified)' : 'ReleaseFast',
  engine,
  engineSha256: createHash('sha256').update(readFileSync(engine)).digest('hex'),
  rounds,
  warmupMs: 1000,
  sampleMs: 100,
  samples: 15,
  flags: tools.map((t) => ({ name: t.name, command: t.command, args: t.args })),
  envOverrides: {
    NODE_OPTIONS: '',
    JSRT_GC_TRACE: '0',
    JSRT_GC_VERIFY: '0',
    JSRT_GC_STRESS: '0',
    STATOR_JIT_TRACE: '0',
  },
};
type Run = ReturnType<typeof parseSteady> & {
  readonly engine: string;
  readonly round: number;
  readonly processMs: number;
  readonly peakRssBytes: number;
};
interface Measurement {
  readonly file: string;
  readonly sha256: string;
  readonly expected: readonly number[];
  readonly runs: readonly Run[];
  readonly gc: ReturnType<typeof measuredGc>;
  readonly v8Gc: ReturnType<typeof measuredV8Gc>;
  readonly gcCalls: number;
  readonly v8GcCalls: number;
  readonly jitProof: readonly string[];
}
const measurements: Measurement[] = [];
const rows: string[] = [];
for (const file of readdirSync(corpus)
  .filter((f) => f.endsWith('.ts'))
  .sort()) {
  const source = stripTypeScriptTypes(readFileSync(join(corpus, file), 'utf8'));
  const oracle = timedRun(
    node,
    ['--eval', `${source}\nfor (let i = 0; i < 16; i++) console.log(bench(i));`],
    { env },
  );
  if (oracle.status !== 0) throw new Error(`oracle failed for ${file}: ${oracle.stderr}`);
  const expected = oracle.stdout.trim().split('\n').map(Number);
  const script = source + steadyDriver(expected, metadata.warmupMs, metadata.sampleMs);
  const path = join(out, file.replace(/\.ts$/, '.js'));
  writeFileSync(path, script);
  const checksum = expected.reduce((a, b) => a + b, 0);
  const runs: Run[] = [];
  process.stdout.write(`measuring ${file}\n`);
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0 ? tools : [...tools].reverse();
    for (const tool of order) {
      const r = timedRun(tool.command, [...tool.args, path], { env, timeout: 180_000 });
      if (r.status !== 0) throw new Error(`${tool.name} failed: ${r.stderr}`);
      const result = parseSteady(r.stdout, checksum);
      if (
        result.warmupMs < metadata.warmupMs ||
        result.samples.some((s) => s.ms < metadata.sampleMs)
      )
        throw new Error('benchmark did not reach its time budget');
      runs.push({
        engine: tool.name,
        round,
        ...result,
        processMs: r.ms,
        peakRssBytes: r.maxRssBytes,
      });
    }
  }
  // Separate run: synchronous trace output must never inflate the throughput comparison.
  const traced = timedRun(engine, [path], {
    env: { ...env, JSRT_GC_TRACE: '1', STATOR_JIT_TRACE: '1' },
    timeout: 180_000,
  });
  if (traced.status !== 0) throw new Error(`GC trace run failed: ${traced.stderr}`);
  const tracedResult = parseSteady(traced.stdout, checksum);
  const jitProof = traced.stderr.split('\n').filter((line) => line.startsWith('jit: '));
  for (const name of ['bench', 'checkedBatch']) {
    if (!jitProof.some((line) => line.startsWith(`jit: ${name}: compiled:`)))
      throw new Error(`${file}: ${name} was not JIT compiled`);
  }
  const gc = measuredGc(traced.stderr);
  if (file !== 'numeric.ts' && gc.length === 0)
    throw new Error(`no measured collections for ${file}`);
  const v8Traced = timedRun(node, ['--require', join(out, 'gc-clock.cjs'), path], {
    env,
    timeout: 180_000,
  });
  if (v8Traced.status !== 0) throw new Error(`V8 GC observation failed: ${v8Traced.stderr}`);
  const v8TracedResult = parseSteady(v8Traced.stdout, checksum);
  const v8Gc = measuredV8Gc(v8Traced.stderr);
  if (file !== 'numeric.ts' && v8Gc.length === 0)
    throw new Error(`no observed V8 GC events for ${file}`);
  const medians = tools.map((tool) =>
    percentile(
      runs
        .filter((r) => r.engine === tool.name)
        .map((r) =>
          percentile(
            r.samples.map((s) => (s.ms * 1000) / s.calls),
            0.5,
          ),
        ),
      0.5,
    ),
  );
  const v8 = medians[0] ?? Number.NaN;
  const jit = medians[1] ?? Number.NaN;
  rows.push(
    `| ${file} | ${v8.toFixed(3)} | ${jit.toFixed(3)} | ${(jit / v8).toFixed(2)} | ${gc.length} | ${(
      percentile(
        gc.map((g) => g.pauseNs),
        0.99,
      ) / 1e6
    ).toFixed(3)} | ${(
      percentile(
        v8Gc.map((g) => g.durationNs),
        0.99,
      ) / 1e6
    ).toFixed(3)} |`,
  );
  measurements.push({
    file,
    sha256: createHash('sha256').update(script).digest('hex'),
    expected,
    runs,
    gc,
    v8Gc,
    gcCalls: tracedResult.samples.reduce((sum, sample) => sum + sample.calls, 0),
    v8GcCalls: v8TracedResult.samples.reduce((sum, sample) => sum + sample.calls, 0),
    jitProof,
  });
  writeFileSync(
    join(out, 'results.json'),
    `${JSON.stringify({ metadata, measurements, loadAfter: loadavg() }, null, 2)}\n`,
  );
}
const table = [
  'Median of per-process medians, microseconds per checked kernel call after >=1s warmup.',
  'JIT / V8 > 1 means Stator is slower. GC columns come from separate instrumented runs; V8 reports GC event duration, Stator full collection latency.',
  '',
  '| kernel | V8 us | JIT us | JIT / V8 | Stator GC count | Stator GC p99 ms | V8 GC event p99 ms |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...rows,
].join('\n');
writeFileSync(join(out, 'SUMMARY.md'), `${table}\n`);
process.stdout.write(`${table}\nResults: ${out}\n`);
