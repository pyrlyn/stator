/* The ASan content-hash gate's pure core (plan.md §9 Task 6.8, option (a)).
 *
 * What is proved here, without touching a toolchain: the hash is deterministic and moves
 * with every input it claims to cover (archive members, flags, tracked files, compiler and
 * oracle versions, platform, env pins, TypeScript); member/file ORDER does not move it
 * (sorted lists); a green record round-trips through the tmp+rename write; a mismatched
 * or corrupt record is not green; only `STATOR_ASAN_FORCE=1` forces the full pass; and
 * the skip line carries the hash prefix, the provenance, and the force escape.
 *
 * `collectGateInputs` (the filesystem/git half) is deliberately NOT covered here: it
 * needs a built `build-asan/` tree, which would make this file a native test. */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  formatSkipLine,
  greenMatches,
  hashGateInputs,
  isForceRequested,
  readGreenRecord,
  writeGreenRecord,
  type AsanGreenRecord,
  type GateInputs,
} from '../golden/asan-gate.ts';

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sampleInputs(): GateInputs {
  return {
    archiveMembers: [
      { name: 'jsrt_b.o', bytes: text('b-object') },
      { name: 'jsrt_a.o', bytes: text('a-object') },
    ],
    linkFlags: ' -licuuc -lm',
    cflags: 'Apple clang version 21.0.0 -O1 -g -fsanitize=address,undefined',
    tracked: [
      { path: 'packages/runtime/src/b.c', bytes: text('int b(void){return 1;}') },
      { path: 'packages/compiler/src/a.ts', bytes: text('export const a = 1;') },
    ],
    ccVersion: 'Apple clang version 21.0.0 (clang-2100.1.1.101)',
    nodeVersion: 'v26.8.2',
    uname: 'Darwin arm64',
    asanOptions: 'detect_leaks=0',
    statorRuntime: '',
    typescriptVersion: '6.0.3',
  };
}

function sampleRecord(hash: string): AsanGreenRecord {
  return {
    version: 1,
    hash,
    recordedAt: '2026-09-14T00:00:00.000Z',
    commit: 'abc1237def',
    passed: 212,
    failed: 0,
    total: 212,
  };
}

test('the gate hash is deterministic and sensitive to every input', () => {
  const base = sampleInputs();
  assert.equal(hashGateInputs(base), hashGateInputs(sampleInputs()));
  const variants: GateInputs[] = [
    { ...base, linkFlags: ' -lm' },
    { ...base, cflags: 'other flags' },
    { ...base, ccVersion: 'other compiler' },
    { ...base, nodeVersion: 'other node' },
    { ...base, uname: 'other platform' },
    { ...base, asanOptions: '' },
    { ...base, statorRuntime: 'asan' },
    { ...base, typescriptVersion: 'other ts' },
    // Fewer members, changed bytes, and a bare rename with identical bytes.
    { ...base, archiveMembers: [{ name: 'jsrt_a.o', bytes: text('a-object') }] },
    {
      ...base,
      archiveMembers: [
        { name: 'jsrt_b.o', bytes: text('b-object') },
        { name: 'jsrt_a.o', bytes: text('CHANGED') },
      ],
    },
    {
      ...base,
      archiveMembers: [
        { name: 'jsrt_b.o', bytes: text('b-object') },
        { name: 'jsrt_renamed.o', bytes: text('a-object') },
      ],
    },
    // A changed tracked file, and a renamed path with identical bytes.
    {
      ...base,
      tracked: [{ path: 'packages/runtime/src/b.c', bytes: text('CHANGED') }],
    },
    {
      ...base,
      tracked: [
        { path: 'packages/runtime/src/b.c', bytes: text('int b(void){return 1;}') },
        { path: 'packages/compiler/src/renamed.ts', bytes: text('export const a = 1;') },
      ],
    },
  ];
  for (const variant of variants) {
    assert.notEqual(hashGateInputs(variant), hashGateInputs(base));
  }
});

test('member and file order do not move the hash (sorted lists)', () => {
  const base = sampleInputs();
  const shuffled: GateInputs = {
    ...base,
    archiveMembers: [...base.archiveMembers].reverse(),
    tracked: [...base.tracked].reverse(),
  };
  assert.equal(hashGateInputs(shuffled), hashGateInputs(base));
});

test('a green record round-trips through the tmp+rename write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stator-asan-gate-'));
  try {
    const path = join(dir, '.asan-last-green.json');
    const record = sampleRecord('ab'.repeat(32));
    writeGreenRecord(path, record);
    assert.deepEqual(readGreenRecord(path), record);
    assert.equal(greenMatches(readGreenRecord(path), record.hash), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hash mismatch — or a corrupt record — is not green', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stator-asan-gate-'));
  try {
    const record = sampleRecord('ab'.repeat(32));
    assert.equal(greenMatches(record, 'cd'.repeat(32)), false);
    assert.equal(greenMatches(undefined, record.hash), false);
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, 'not json{', 'utf8');
    assert.equal(readGreenRecord(corrupt), undefined);
    assert.equal(readGreenRecord(join(dir, 'missing.json')), undefined);
    const wrongVersion = join(dir, 'wrong.json');
    writeFileSync(wrongVersion, JSON.stringify({ ...record, version: 2 }), 'utf8');
    assert.equal(readGreenRecord(wrongVersion), undefined);
    const wrongShape = join(dir, 'shape.json');
    writeFileSync(wrongShape, JSON.stringify({ version: 1, hash: record.hash }), 'utf8');
    assert.equal(readGreenRecord(wrongShape), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only STATOR_ASAN_FORCE=1 forces the full pass', () => {
  assert.equal(isForceRequested({ STATOR_ASAN_FORCE: '1' }), true);
  assert.equal(isForceRequested({}), false);
  assert.equal(isForceRequested({ STATOR_ASAN_FORCE: '0' }), false);
  assert.equal(isForceRequested({ STATOR_ASAN_FORCE: '' }), false);
  assert.equal(isForceRequested({ STATOR_ASAN_FORCE: 'true' }), false);
});

test('the skip line carries the hash prefix, provenance, and force escape', () => {
  const hash = '0123456789abcdef'.repeat(4);
  const line = formatSkipLine(sampleRecord(hash), hash);
  assert.match(line, /0123456789ab/);
  assert.match(line, /2026-09-14/);
  assert.match(line, /abc1237/);
  assert.match(line, /212\/212/);
  assert.match(line, /STATOR_ASAN_FORCE=1/);
});
