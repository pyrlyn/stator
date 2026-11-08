import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  fanOutWorkers,
  mergeShardFiles,
  parseShardArgs,
  runnerShardCount,
  type ShardArgs,
} from '../support/parallel.ts';

function args(argv: readonly string[] = []): ShardArgs {
  return parseShardArgs(argv, {
    onUnknownFlag: (flag) => {
      throw new Error(flag);
    },
    missingFilterMessage: 'missing filter',
  });
}

const HOST = { cores: 16, memory: 64 * 1024 ** 3, env: {} };

test('full runs use a bounded CPU and memory budget', () => {
  assert.equal(runnerShardCount(args(), 1041, HOST), 4);
  assert.equal(runnerShardCount(args(), 1041, { ...HOST, cores: 2 }), 2);
  assert.equal(runnerShardCount(args(), 1041, { ...HOST, cores: 1 }), undefined);
  assert.equal(runnerShardCount(args(), 1041, { ...HOST, memory: 4 * 1024 ** 3 }), 2);
  assert.equal(runnerShardCount(args(), 1041, { ...HOST, memory: 2 * 1024 ** 3 }), undefined);
  for (const jobs of ['1', '2', '0', 'bad']) {
    assert.equal(
      runnerShardCount(args(), 1041, { ...HOST, env: { STATOR_TEST_JOBS: jobs } }),
      jobs === '1' ? undefined : jobs === '2' ? 2 : 4,
    );
  }
});

test('focused runs, impact recording and explicit selectors preserve their execution mode', () => {
  for (const argv of [[], ['--filter=class'], ['--only=selected.txt'], ['--shard=2/4']]) {
    assert.equal(runnerShardCount(args(argv), argv.length === 0 ? 31 : 1041, HOST), undefined);
  }
  assert.equal(runnerShardCount(args(), 0, HOST), undefined);
  assert.equal(
    runnerShardCount(args(), 1041, { ...HOST, env: { STATOR_IMPACT_RECORD: '/record' } }),
    undefined,
  );
  assert.equal(runnerShardCount(args(['--shards=1']), 1041, HOST), 1);
  assert.equal(runnerShardCount(args(['--shards=8', '--filter=x']), 1, HOST), 8);
});

test('workers merge every result in order, share automatic pool slots, and propagate crashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stator-parallel-proof-'));
  const script = join(dir, 'worker.ts');
  const support = new URL('../support/parallel.ts', import.meta.url).href;
  writeFileSync(
    script,
    `
import { parseShardArgs, shardSlice, writeShardFile } from ${JSON.stringify(support)};
if (process.argv.includes('--fail')) process.exit(7);
const args = parseShardArgs(process.argv.slice(2), {
  onUnknownFlag: (flag: string) => { throw new Error(flag); },
  missingFilterMessage: 'missing filter',
});
if (args.shard === undefined || args.jsonOut === undefined) throw new Error('missing worker flags');
writeShardFile(args.jsonOut, shardSlice(['a', 'b', 'c', 'd', 'e'], args.shard).map(({item, index}) => ({
  index, key: item, value: item + ':' + process.env['STATOR_TEST_JOBS'],
})).reverse());
`,
  );
  try {
    await fanOutWorkers({ script, dir, shards: 2, baseArgs: [], sharedJobs: true });
    const requested = Number.parseInt(process.env['STATOR_TEST_JOBS'] ?? '', 10);
    const jobs = Number.isFinite(requested) && requested > 0 ? requested : availableParallelism();
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const decode = (value: unknown): string => {
      assert.equal(typeof value, 'string');
      if (typeof value !== 'string') throw new Error('invalid result');
      return value;
    };
    const options = { dir, shards: 2, keys, decode };
    assert.deepEqual(
      mergeShardFiles(options),
      keys.map((key) => `${key}:${Math.max(1, Math.floor(jobs / 2))}`),
    );
    await assert.rejects(
      fanOutWorkers({ script, dir, shards: 2, baseArgs: ['--fail'] }),
      /2 shard worker\(s\) failed/,
    );
    writeFileSync(join(dir, 'shard-1-of-2.json'), '[]');
    assert.throws(() => mergeShardFiles(options), /no shard reported item/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
