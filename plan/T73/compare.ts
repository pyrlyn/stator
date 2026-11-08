import { readFileSync, writeFileSync } from 'node:fs';
import { timedRun } from '../../packages/tests/support/timed-run.ts';
import { parseSteady, percentile } from '../../packages/tests/engine/steady-protocol.ts';
import { createHash } from 'node:crypto';
import { arch, cpus, loadavg, platform, release } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { nodePath } from '../../packages/tests/support/node-path.ts';
import { onPath } from '../../packages/tests/support/on-path.ts';
const suffix = process.platform === 'win32' ? '.exe' : '';
const git = onPath(`git${suffix}`);
const zig = onPath(`zig${suffix}`);
if (!git || !zig) throw new Error('git and zig must be installed');
const [before, after, source] = process.argv.slice(2);
if (!before || !after || !source || process.argv.length !== 5)
  throw new Error('usage: compare.ts BASELINE CHANGED GENERATED_CORPUS');
const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const metadata = {
  cpu: cpus()[0]?.model,
  platform: platform(),
  arch: arch(),
  os: release(),
  node: process.version,
  v8: process.versions.v8,
  zig: execFileSync(resolve(zig), ['version'], { encoding: 'utf8' }).trim(),
  commit: execFileSync(resolve(git), ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  runtimeDiffSha256: createHash('sha256')
    .update(execFileSync(resolve(git), ['diff', '--', 'packages/runtime']))
    .digest('hex'),
  build: 'steady: ReleaseFast; runtime: C -O2, Zig ReleaseSafe, no LTO',
  beforeSha256: sha256(before),
  afterSha256: sha256(after),
  loadBefore: loadavg(),
  warmupMs: 1000,
  sampleMs: 100,
  samples: 15,
  rounds: 5,
};
const tools = [
  { name: 'before', command: before, args: [] },
  { name: 'after', command: after, args: [] },
  { name: 'V8', command: nodePath(), args: ['--require', resolve(source, 'clock.cjs')] },
];
const results = [];
for (const kernel of ['numeric', 'objects', 'cycles']) {
  const script = `${source}/${kernel}.js`;
  const text = readFileSync(script, 'utf8');
  const expected: unknown = JSON.parse(text.split('var expected = ')[1]?.split(';')[0] ?? 'null');
  if (!Array.isArray(expected) || !expected.every((n: unknown) => typeof n === 'number'))
    throw new Error('expected values');
  const checksum = (expected as number[]).reduce((sum, n) => sum + n, 0);
  for (let round = 0; round < 5; round++) {
    for (const tool of [
      ...tools.slice(round % tools.length),
      ...tools.slice(0, round % tools.length),
    ]) {
      const r = timedRun(tool.command, [...tool.args, script], {
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          JSRT_GC_TRACE: '0',
          STATOR_JIT_TRACE: '0',
          JSRT_GC_VERIFY: '0',
          JSRT_GC_STRESS: '0',
        },
      });
      if (r.status !== 0) throw new Error(r.stderr);
      const measured = parseSteady(r.stdout, checksum);
      const us = percentile(
        measured.samples.map((s) => (s.ms * 1000) / s.calls),
        0.5,
      );
      if (measured.warmupMs < 1000 || measured.samples.some((s) => s.ms < 100))
        throw new Error('time budget');
      results.push({
        kernel,
        tool: tool.name,
        round,
        us,
        processMs: r.ms,
        peakRssBytes: r.maxRssBytes,
        sourceSha256: sha256(script),
        at: new Date().toISOString(),
        load: loadavg(),
        ...measured,
      });
      console.log(kernel, tool.name, round, us);
      writeFileSync(
        'plan/T73/interleaved.json',
        JSON.stringify({ metadata, tools, source, results, loadAfter: loadavg() }, null, 2) + '\n',
      );
    }
  }
}
