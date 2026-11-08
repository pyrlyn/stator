/* Identical JavaScript input in the interpreter, QuickJS and optional PrimJS; Node is the oracle.
 * BENCH_RUNS controls interleaved repetitions (at least 5), QJS selects QuickJS, and
 * STATOR_ENGINE_BASELINE optionally includes a saved ReleaseFast interpreter. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodePath } from '../support/node-path.ts';
import { onPath } from '../support/on-path.ts';
import { timedRun } from '../support/timed-run.ts';
import { engineBinary, REPO } from './binary.ts';

const runs = Number(process.env['BENCH_RUNS'] ?? 7);
if (!Number.isSafeInteger(runs) || runs < 5) throw new Error('BENCH_RUNS must be at least 5');
const qjs = process.env['QJS'] ?? 'qjs';
const exe = process.platform === 'win32' ? '.exe' : '';
const git = onPath(`git${exe}`);
const zig = onPath(`zig${exe}`);
if (git === undefined || zig === undefined) throw new Error('git and zig are required on PATH');
const selectedEngine = engineBinary('ReleaseFast');
// A concurrent build must not replace the executable halfway through the comparison.
const snapshot = mkdtempSync(join(tmpdir(), 'stator-quickjs-'));
process.on('exit', () => rmSync(snapshot, { recursive: true, force: true }));
const engine = join(snapshot, process.platform === 'win32' ? 'stator-engine.exe' : 'stator-engine');
copyFileSync(selectedEngine, engine);
const engineSha256 = createHash('sha256').update(readFileSync(engine)).digest('hex');
const baseline = process.env['STATOR_ENGINE_BASELINE'];
const primjs = process.env['PRIMJS'];
const tools = [
  { name: 'interp', command: engine, args: ['run', '--mode=interp', '--lang=js'] },
  { name: 'quickjs', command: qjs, args: ['--script'] },
  ...(primjs === undefined ? [] : [{ name: 'primjs', command: primjs, args: [] }]),
  ...(baseline === undefined
    ? []
    : [{ name: 'baseline', command: baseline, args: ['run', '--mode=interp', '--lang=js'] }]),
];
const sourceDir = join(REPO, 'packages/tests/engine/scripts/bench');
const rows = readdirSync(sourceDir)
  .filter((n) => n.endsWith('.ts'))
  .sort()
  .map((name) => {
    const file = join(sourceDir, name);
    const expected = timedRun(nodePath(), [file]);
    if (expected.status !== 0) throw new Error(`Node failed on ${name}: ${expected.stderr}`);
    const samples = tools.map((): number[] => []);
    for (let round = -1; round < runs; round += 1) {
      // One untimed round pages in each executable; rotate order to distribute host drift.
      for (let i = 0; i < tools.length; i += 1) {
        const index = (i + round + 1) % tools.length;
        const tool = tools[index];
        if (tool === undefined) throw new Error('missing tool');
        const result = timedRun(tool.command, [...tool.args, file]);
        if (result.status !== 0 || result.stdout !== expected.stdout) {
          throw new Error(
            `${tool.name} on ${name}: exit ${String(result.status)}, output ${JSON.stringify(result.stdout)}; expected ${JSON.stringify(expected.stdout)}\n${result.stderr}`,
          );
        }
        if (round >= 0) samples[index]?.push(result.ms);
      }
    }
    const measurements = tools.map((tool, index) => {
      const rawMs = samples[index] ?? [];
      const sorted = rawMs.toSorted((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const medianMs =
        ((sorted[middle] ?? 0) + (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0)) / 2;
      return {
        tool: tool.name,
        medianMs,
        minMs: sorted[0],
        maxMs: sorted.at(-1),
        p25Ms: sorted[Math.floor((sorted.length - 1) / 4)] ?? 0,
        p75Ms: sorted[Math.ceil((3 * (sorted.length - 1)) / 4)] ?? 0,
        rawMs,
      };
    });
    process.stdout.write(
      `${name}: ${measurements.map((m) => `${m.tool} ${m.medianMs.toFixed(2)} ms [${m.minMs?.toFixed(2)}, ${m.maxMs?.toFixed(2)}]`).join('; ')}\n`,
    );
    return {
      name,
      faster: (measurements[0]?.p75Ms ?? Infinity) < (measurements[1]?.p25Ms ?? 0),
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      stdout: expected.stdout,
      measurements,
    };
  });
const report = {
  timestamp: new Date().toISOString(),
  revision: execFileSync(git, ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
  diff: execFileSync(git, ['diff', '--', 'packages/engine', 'packages/runtime'], {
    cwd: REPO,
    encoding: 'utf8',
  }),
  host: { cpu: cpus()[0]?.model, platform: platform(), release: release(), arch: arch() },
  node: execFileSync(nodePath(), ['--version'], { encoding: 'utf8' }).trim(),
  quickjs: spawnSync(qjs, ['--help'], { encoding: 'utf8' }).stdout?.split('\n')[0],
  primjs:
    primjs === undefined
      ? undefined
      : {
          binarySha256: createHash('sha256').update(readFileSync(primjs)).digest('hex'),
          version: process.env['PRIMJS_VERSION'],
          revision: process.env['PRIMJS_REVISION'],
          buildArgs: process.env['PRIMJS_BUILD_ARGS'],
          runtimeInfo: spawnSync(primjs, ['--runtime-info', join(sourceDir, 'loop.ts')], {
            encoding: 'utf8',
          }).stderr,
        },
  zig: execFileSync(zig, ['version'], { encoding: 'utf8' }).trim(),
  build: 'ReleaseFast',
  metric: 'wall milliseconds including startup, one warmup, rotating order',
  runs,
  selectedEngine,
  engineSha256,
  tools,
  rows,
};
const out = join(REPO, 'packages/tests/engine/results');
mkdirSync(out, { recursive: true });
const file = join(out, `quickjs-${report.timestamp.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`wrote ${file}\n`);
const losses = rows.filter((row) => !row.faster).map((row) => row.name);
process.stdout.write(
  `Faster with non-overlapping interquartile ranges: ${rows.length - losses.length}/${rows.length}\n`,
);
if (process.argv.includes('--require-faster') && losses.length > 0) {
  process.stderr.write(`QuickJS target unmet: ${losses.join(', ')}\n`);
  process.exitCode = 1;
}
