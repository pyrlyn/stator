// The engine harness's account of a run with no exit status (packages/tests/support/ended-by.ts).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';
import { endedBy } from '../support/ended-by.ts';

test('a run killed at its timeout says so, with the budget', () => {
  const r = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { timeout: 200 });
  assert.equal(r.status, null);
  assert.equal(endedBy(r, 200), '\n[harness] timed out after 0.2 s and was killed');
});

test('a run a signal ended names the signal', () => {
  const r = spawnSync(process.execPath, ['-e', "process.kill(process.pid, 'SIGABRT')"]);
  assert.equal(r.status, null);
  assert.equal(endedBy(r, 60_000), '\n[harness] killed by SIGABRT');
});

test('a run that exited adds nothing', () => {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(r.status, 3);
  assert.equal(endedBy(r, 60_000), '');
});
