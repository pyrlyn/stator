/* Isolate traversal cost from parsing/type checking. Optional argument: another checkout root.
 * Run with --expose-gc --max-semi-space-size=128 so one measured walk fits in the young heap. */
import { strict as assert } from 'node:assert';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Rewriter,
  rewriteModule as rewriteModuleType,
} from '../../compiler/src/passes/rewrite.ts';
import { consoleLog, exprStmt, makeModule, num } from '../unit/helpers.ts';

interface Measurement {
  root: string;
  rewriteModule: typeof rewriteModuleType;
  times: number[];
  cpuTimes: number[];
  heaps: number[];
}
const implementations: Pick<Measurement, 'root' | 'rewriteModule'>[] = [];
for (const root of new Set([resolve('.'), resolve(process.argv[2] ?? '.')])) {
  const { rewriteModule }: { rewriteModule: typeof rewriteModuleType } = await import(
    pathToFileURL(resolve(root, 'packages/compiler/src/passes/rewrite.ts')).href
  );
  implementations.push({ root, rewriteModule });
}
const first = implementations[0];
assert.ok(first);
const collect = globalThis.gc;
assert.ok(collect, 'run with --expose-gc');
const count = 10_000;
const module = makeModule(
  Array.from({ length: count }, (_, i) =>
    exprStmt(consoleLog(Array.from({ length: 8 }, (_, j) => num(i * 8 + j)))),
  ),
);
const cases: readonly [string, Rewriter][] = [
  ['unchanged', { expression: (expr) => expr }],
  [
    'sparse',
    {
      expression: (expr) =>
        expr.kind === 'number-literal' && expr.value % 1000 === 999
          ? { ...expr, value: -expr.value }
          : expr,
    },
  ],
  [
    'changed',
    {
      expression: (expr) =>
        expr.kind === 'number-literal' ? { ...expr, value: -expr.value } : expr,
    },
  ],
  ['statement-identity', { statement: (stmt) => [stmt] }],
];
process.stdout.write(
  `${JSON.stringify({
    node: process.version,
    cpu: cpus()[0]?.model,
    platform: process.platform,
    arch: process.arch,
    roots: implementations.map((implementation) => implementation.root),
    statements: count,
  })}\n`,
);
for (const [name, rewriter] of cases) {
  const expected = first.rewriteModule(module, rewriter);
  const measurements = implementations.map<Measurement>((implementation) => ({
    ...implementation,
    times: [],
    cpuTimes: [],
    heaps: [],
  }));
  for (const implementation of implementations) {
    for (let i = 0; i < 20; i++) implementation.rewriteModule(module, rewriter);
  }
  for (let i = 0; i < 15; i++) {
    // Alternate order so a warming machine or concurrent load does not always favour one version.
    const ordered = i % 2 === 0 ? measurements : [...measurements].reverse();
    for (const measurement of ordered) {
      collect();
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      for (let j = 0; j < 25; j++) measurement.rewriteModule(module, rewriter);
      measurement.times.push((performance.now() - start) / 25);
      const cpu = process.cpuUsage(cpuStart);
      measurement.cpuTimes.push((cpu.user + cpu.system) / 25_000);
      collect();
      const before = process.memoryUsage().heapUsed;
      const result = measurement.rewriteModule(module, rewriter);
      measurement.heaps.push(process.memoryUsage().heapUsed - before);
      assert.deepEqual(result, expected);
      if (name === 'unchanged' || name === 'statement-identity') assert.equal(result, module);
    }
  }
  for (const { root, times, cpuTimes, heaps } of measurements) {
    times.sort((a, b) => a - b);
    cpuTimes.sort((a, b) => a - b);
    heaps.sort((a, b) => a - b);
    process.stdout.write(
      `${JSON.stringify({ name, root, medianMs: times[7], medianCpuMs: cpuTimes[7], medianHeapGrowth: heaps[7] })}\n`,
    );
  }
}
