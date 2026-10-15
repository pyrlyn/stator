import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { clearProgramCache, createProgram } from '../../compiler/src/frontend/program.ts';

/** A whole-second mtime: float milliseconds round-trip through the syscall exactly, so two
 * writes pinned to it compare `===` — which is precisely the collision under test. A raw
 * `statSync().mtimeMs` float does NOT round-trip (sub-millisecond truncation), and a test
 * built on it passes against the old code for the wrong reason. */
const PINNED_MTIME_S = 1_000_000;

function entryText(entry: string, mode: 'ts' | 'js'): string {
  const { program } = createProgram(entry, mode);
  const source = program.getSourceFile(resolve(entry).replace(/\\/g, '/'));
  assert.ok(source !== undefined, 'the entry must be in its own program');
  return source.getFullText();
}

test('the program cache keys on content, not mtime', () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-program-cache-'));
  try {
    clearProgramCache();
    const entry = join(work, 'entry.ts');
    writeFileSync(entry, 'console.log(1);\n');
    utimesSync(entry, PINNED_MTIME_S, PINNED_MTIME_S);
    assert.match(entryText(entry, 'ts'), /console\.log\(1\)/);

    // Same bytes rebuild hits the cache (the point of keeping it at all).
    const { program: again } = createProgram(entry, 'ts');
    const { program: firstProgram } = createProgram(entry, 'ts');
    assert.equal(again, firstProgram, 'unchanged content must reuse the cached program');

    // Different bytes under an IDENTICAL mtime must not serve the stale program: test262
    // stages thousands of tests through slot-reused temp paths, where (path, mtime) repeats
    // for different contents on a coarse-tick filesystem (plan-notes 245).
    writeFileSync(entry, 'console.log(2);\n');
    utimesSync(entry, PINNED_MTIME_S, PINNED_MTIME_S);
    const second = entryText(entry, 'ts');
    assert.match(second, /console\.log\(2\)/, 'changed content must rebuild, mtime be damned');
    assert.doesNotMatch(second, /console\.log\(1\)/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the program cache misses when a transitive import changes', () => {
  const work = mkdtempSync(join(tmpdir(), 'stator-program-cache-dep-'));
  try {
    clearProgramCache();
    const entry = join(work, 'entry.ts');
    const mid = join(work, 'mid.ts');
    const leaf = join(work, 'leaf.ts');
    writeFileSync(leaf, 'export const n: number = 1;\n');
    writeFileSync(mid, 'import { n } from "./leaf.ts";\nexport const m: number = n;\n');
    writeFileSync(entry, 'import { m } from "./mid.ts";\nconsole.log(m);\n');
    const first = createProgram(entry, 'ts');
    const again = createProgram(entry, 'ts');
    assert.equal(again.program, first.program, 'unchanged dependencies must hit');

    writeFileSync(leaf, 'export const n: number = 2;\n');
    const third = createProgram(entry, 'ts');
    assert.notEqual(
      third.program,
      first.program,
      'a leaf edit must miss even though the entry did not',
    );
    const leafFile = third.program.getSourceFile(resolve(leaf).replace(/\\/g, '/'));
    assert.ok(leafFile !== undefined);
    assert.match(leafFile.getFullText(), /export const n: number = 2/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
