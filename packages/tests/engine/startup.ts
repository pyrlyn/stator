/* Startup and compilation are independent: trace I/O never supplies cold process timings. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, release } from 'node:os';
import { join } from 'node:path';
import { engineBinary, REPO } from './binary.ts';
import { compilationCorpus, parseCompilation } from './compile-protocol.ts';
import { percentile } from './steady-protocol.ts';
import { nodePath } from '../support/node-path.ts';
import { timedRun } from '../support/timed-run.ts';

let rounds = 9;
for (const arg of process.argv.slice(2)) {
  if (!/^--rounds=[1-9][0-9]*$/.test(arg)) throw new Error(`unknown option: ${arg}`);
  rounds = Number(arg.slice('--rounds='.length));
  if (!Number.isSafeInteger(rounds) || rounds > 100) throw new Error('rounds must be 1..100');
}
const engine = engineBinary('ReleaseFast');
const node = nodePath();
const before = process.env['STATOR_ENGINE_BEFORE'];
const out = join(
  REPO,
  'packages/tests/engine/results',
  `startup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
mkdirSync(out, { recursive: true });
const env = {
  ...process.env,
  NODE_OPTIONS: '',
  STATOR_JIT_TRACE: '0',
  JSRT_GC_TRACE: '0',
  JSRT_GC_VERIFY: '0',
  JSRT_GC_STRESS: '0',
};
const version = (command: string, args: readonly string[]): string =>
  execFileSync(command, args, { cwd: REPO, env, encoding: 'utf8' }).trim();
const hash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const metadata = {
  commit: version('git', ['rev-parse', 'HEAD']),
  dirty: version('git', ['status', '--short']),
  cpu: cpus()[0]?.model ?? 'unknown',
  platform: platform(),
  os: release(),
  arch: arch(),
  node: version(node, ['--version']),
  v8: version(node, ['-p', 'process.versions.v8']),
  zig: version('zig', ['version']),
  rounds,
  loadBefore: loadavg(),
  engine: {
    path: engine,
    hash: hash(engine),
    build: process.env['STATOR_ENGINE'] ? 'external (verify separately)' : 'ReleaseFast',
  },
  before: before ? { path: before, hash: hash(before) } : null,
  envOverrides: {
    NODE_OPTIONS: '',
    STATOR_JIT_TRACE: '0',
    JSRT_GC_TRACE: '0',
    JSRT_GC_VERIFY: '0',
    JSRT_GC_STRESS: '0',
  },
};
interface Tool {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly tier?: 'stator' | 'sparkplug' | 'turbofan';
}
const stator: Tool[] = [
  ...(before ? [{ name: 'Stator before', command: before, args: ['run', '--mode=jit'] }] : []),
  { name: 'Stator', command: engine, args: ['run', '--mode=jit'] },
];
const cold: readonly Tool[] = [{ name: 'Node', command: node, args: [] }, ...stator];
const compile: readonly Tool[] = [
  {
    name: 'V8 Sparkplug',
    command: node,
    args: [
      '--always-sparkplug',
      '--no-concurrent-sparkplug',
      '--no-baseline-batch-compilation',
      '--no-maglev',
      '--no-opt',
      '--trace-baseline',
      '--sparkplug-filter=t74_kernel_*',
    ],
    tier: 'sparkplug',
  },
  {
    name: 'V8 TurboFan',
    command: node,
    args: ['--allow-natives-syntax', '--no-concurrent-recompilation', '--no-maglev', '--trace-opt'],
    tier: 'turbofan',
  },
  ...stator.map((tool): Tool => ({ ...tool, tier: 'stator' })),
];
const records: unknown[] = [];
const summary: string[] = [];
for (const width of [0, 8, 64]) {
  const corpus = compilationCorpus(width);
  const source = width === 0 ? 'console.log("answer", 42);\n' : corpus.source;
  const path = join(out, `width-${String(width)}.js`);
  const turboPath = join(out, `width-${String(width)}-v8.js`);
  writeFileSync(path, source);
  writeFileSync(turboPath, corpus.turbofan);
  const oracle = timedRun(node, [path], { env });
  if (oracle.status !== 0 || !/^answer [0-9.]+\n$/.test(oracle.stdout))
    throw new Error(`oracle failed: ${oracle.stderr}`);
  for (const phase of width === 0 ? (['cold'] as const) : (['cold', 'compile'] as const)) {
    const tools = phase === 'cold' ? cold : compile;
    const samples = new Map<string, number[]>();
    process.stdout.write(`measuring ${phase}, width ${String(width)}\n`);
    for (let round = 0; round < rounds; round += 1) {
      const offset = round % tools.length;
      for (const tool of [...tools.slice(offset), ...tools.slice(0, offset)]) {
        const args = [...tool.args, tool.tier === 'turbofan' ? turboPath : path];
        const result = timedRun(tool.command, args, {
          env: { ...env, STATOR_JIT_TRACE: tool.tier === 'stator' ? '1' : '0' },
        });
        const answer =
          phase === 'compile'
            ? result.stdout
                .split('\n')
                .filter((line) => !line.startsWith('['))
                .join('\n')
            : result.stdout;
        if (result.status !== 0 || answer !== oracle.stdout)
          throw new Error(`${tool.name} failed: ${result.stderr}\n${result.stdout}`);
        const stages = tool.tier
          ? parseCompilation(`${result.stdout}\n${result.stderr}`, tool.tier, corpus.names)
          : [];
        const value = phase === 'cold' ? result.ms : stages.reduce((sum, s) => sum + s.ns, 0) / 1e6;
        const previous = samples.get(tool.name) ?? [];
        previous.push(value);
        samples.set(tool.name, previous);
        records.push({
          width,
          phase,
          tool: tool.name,
          round,
          command: tool.command,
          args,
          sourceHash: hash(args.at(-1) ?? path),
          ...result,
          stages,
        });
        writeFileSync(
          join(out, 'results.json'),
          `${JSON.stringify({ metadata, records, loadAfter: loadavg() }, null, 2)}\n`,
        );
      }
    }
    for (const [tool, values] of samples)
      summary.push(
        `| ${phase} | ${String(width)} | ${tool} | ${percentile(values, 0.5).toFixed(3)} | ${percentile(values, 0.25).toFixed(3)} | ${percentile(values, 0.75).toFixed(3)} |`,
      );
  }
}
const report = [
  'Cold: process spawn through exit, including the time wrapper; warm filesystem caches, fresh processes.',
  'Compile: sum over 24 identical function bodies; parsing, execution and trace I/O excluded.',
  'Stator: analysis + IR lowering + backend + executable publication, excluding cleanup.',
  'V8: synchronous tier-specific trace durations, rounded to microseconds. Forced tiers are diagnostic runs, not default V8 startup policy.',
  'Sparkplug and TurboFan produce different code quality; these totals alone do not prove a better JIT.',
  '',
  '| phase | body width | engine/tier | median ms | p25 ms | p75 ms |',
  '|---|---:|---|---:|---:|---:|',
  ...summary,
].join('\n');
writeFileSync(join(out, 'SUMMARY.md'), `${report}\n`);
process.stdout.write(`${report}\nResults: ${out}\n`);
