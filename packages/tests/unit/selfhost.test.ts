/* The self-compilation ratchet (plan.md §9 Task 6.19): growth, a new code, a worse verdict and an
 * unlisted package each fail; a shrink fails until `--update` records it. Plus the `FirstNode`
 * fix: an unsupported construct is named by its own syntax kind, never by an enum range marker.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { test } from 'vitest';
import { explainFile } from '../../compiler/src/cli/explain.ts';
import { syntaxKindName } from '../../compiler/src/support/diagnostics.ts';
import {
  type Baseline,
  checkCoverage,
  compare,
  formatBaseline,
  packageDirs,
  parseBaseline,
  parseTargetList,
  tally,
} from '../selfhost/ratchet.ts';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SELFHOST = join(REPO, 'packages', 'tests', 'selfhost');

function committedBaseline(): Baseline {
  const raw: unknown = JSON.parse(readFileSync(join(SELFHOST, 'baseline.json'), 'utf8'));
  return parseBaseline(raw);
}

const BASE: Baseline = {
  'packages/compiler': { verdict: 'not-yet', codes: { STA1214: 10 } },
  'packages/std/src/env.ts': { verdict: 'dynamic', codes: {} },
};

test('the measured tree matching the baseline passes', () => {
  assert.deepEqual(compare(BASE, BASE), { regressions: [], improvements: [] });
});

test('a hand-raised count fails', () => {
  const baseline = committedBaseline();
  const compiler = baseline['packages/compiler'];
  assert.ok(compiler !== undefined);
  const count = compiler.codes['STA1214'] ?? 0;
  const raised: Baseline = {
    ...baseline,
    'packages/compiler': { ...compiler, codes: { ...compiler.codes, STA1214: count + 1 } },
  };
  assert.deepEqual(compare(baseline, raised).regressions, [
    `packages/compiler: STA1214 ${String(count)} -> ${String(count + 1)}`,
  ]);
});

test('a new code fails', () => {
  const measured: Baseline = {
    ...BASE,
    'packages/compiler': { verdict: 'not-yet', codes: { STA1214: 10, STA1210: 1 } },
  };
  assert.deepEqual(compare(BASE, measured).regressions, ['packages/compiler: STA1210 0 -> 1']);
});

test('a worse verdict fails', () => {
  const measured: Baseline = {
    ...BASE,
    'packages/std/src/env.ts': { verdict: 'error', codes: { STA1003: 1 } },
  };
  assert.deepEqual(compare(BASE, measured).regressions, [
    'packages/std/src/env.ts: verdict dynamic -> error',
    'packages/std/src/env.ts: STA1003 0 -> 1',
  ]);
});

test('a target missing from the baseline fails', () => {
  const measured: Baseline = {
    ...BASE,
    'packages/std/src/new.ts': { verdict: 'static', codes: {} },
  };
  assert.equal(compare(BASE, measured).regressions.length, 1);
});

test('a shrink is reported until --update records it', () => {
  const measured: Baseline = {
    'packages/compiler': { verdict: 'not-yet', codes: { STA1214: 9 } },
    'packages/std/src/env.ts': { verdict: 'static', codes: {} },
  };
  assert.deepEqual(compare(BASE, measured), {
    regressions: [],
    improvements: [
      'packages/compiler: STA1214 10 -> 9',
      'packages/std/src/env.ts: verdict dynamic -> static',
    ],
  });
  const updated = parseBaseline(JSON.parse(formatBaseline(measured)));
  assert.deepEqual(compare(updated, measured), { regressions: [], improvements: [] });
});

test('the committed baseline is in --update form', () => {
  const text = readFileSync(join(SELFHOST, 'baseline.json'), 'utf8');
  assert.equal(formatBaseline(committedBaseline()), text);
});

test('tally counts the deciding diagnostics by code', () => {
  const report = {
    verdict: 'not-yet',
    code: 'STA1214',
    diagnostics: [{ code: 'STA1214' }, { code: 'STA1210' }, { code: 'STA1214' }],
  };
  assert.deepEqual(tally(report), { verdict: 'not-yet', codes: { STA1210: 1, STA1214: 2 } });
  assert.deepEqual(tally({ verdict: 'static' }), { verdict: 'static', codes: {} });
  assert.throws(() => tally({ verdict: 'maybe' }), /expected a verdict/);
});

test('every package is a target or marked not a target', () => {
  const list = parseTargetList(JSON.parse(readFileSync(join(SELFHOST, 'targets.json'), 'utf8')));
  assert.deepEqual(checkCoverage(list, packageDirs(REPO)), []);
});

test('an unlisted package fails', () => {
  const list = parseTargetList(JSON.parse(readFileSync(join(SELFHOST, 'targets.json'), 'utf8')));
  assert.deepEqual(checkCoverage(list, [...packageDirs(REPO), 'packages/webapi']), [
    'packages/webapi is neither a self-compilation target nor marked "not a target" in selfhost/targets.json',
  ]);
  assert.deepEqual(
    checkCoverage(
      list,
      packageDirs(REPO).filter((dir) => dir !== 'packages/runtime'),
    ),
    ['packages/runtime is listed in selfhost/targets.json but missing'],
  );
});

test('a non-target needs a reason', () => {
  assert.throws(
    () => parseTargetList({ targets: [], notTargets: { 'packages/x': ' ' } }),
    /needs a reason/,
  );
});

test('syntax kinds are named by the kind, not by a range marker', () => {
  assert.equal(ts.SyntaxKind[ts.SyntaxKind.QualifiedName], 'FirstNode');
  assert.equal(syntaxKindName(ts.SyntaxKind.QualifiedName), 'QualifiedName');
  assert.equal(syntaxKindName(ts.SyntaxKind.VariableStatement), 'VariableStatement');
  assert.equal(syntaxKindName(ts.SyntaxKind.EqualsToken), 'EqualsToken');
});

test('a qualified type name is erased like the type around it', async () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-selfhost-'));
  try {
    writeFileSync(join(work, 'm.ts'), 'export interface T { x: number }\n');
    writeFileSync(
      join(work, 'main.ts'),
      "import type * as m from './m.ts';\n" +
        'function f(v: m.T): number { return v.x; }\n' +
        'console.log(f({ x: 1 }));\n',
    );
    const explanation = await explainFile(join(work, 'main.ts'), 'ts');
    const messages = (explanation.diagnostics ?? []).map((diagnostic) => diagnostic.message);
    assert.ok(!messages.some((message) => message.includes('QualifiedName')));
    assert.ok(!messages.some((message) => message.includes('FirstNode')));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('for-of over a tuple walks it like an array', async () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-selfhost-'));
  try {
    writeFileSync(
      join(work, 'main.ts'),
      "const keys = ['a', 'b'] as const;\n" +
        'for (const key of keys) { console.log(key); }\n' +
        'const pair: [number, number] = [3, 4];\n' +
        'for (const n of pair) { console.log(n * 2); }\n',
    );
    const explanation = await explainFile(join(work, 'main.ts'), 'ts');
    const messages = (explanation.diagnostics ?? []).map((diagnostic) => diagnostic.message);
    assert.ok(!messages.some((message) => message.includes('user iterable')));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
