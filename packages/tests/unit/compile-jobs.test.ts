/* T10.3: `STATOR_COMPILE_JOBS` splits emitted C into units and compiles them together.
 *
 * The split is a pure function of the C text, so most of the proof never runs clang. The
 * native cases are the CI smoke: jobs=1 and jobs=2 must print the same bytes, because a
 * duplicated class descriptor or a per-unit globals array would disagree at run time.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { emitC } from '../../compiler/src/codegen/index.ts';
import { build } from '../../compiler/src/cli/build.ts';
import { BuildError } from '../../compiler/src/support/diagnostics.ts';
import {
  PARALLEL_MIN_CHARS,
  PARALLEL_MIN_FUNCTIONS,
  countTopLevelFunctions,
  partitionTranslationUnit,
  resolveCompileJobs,
  shouldSplitTranslationUnit,
} from '../../compiler/src/cli/compile-jobs.ts';
import { lowerSource, NATIVE_ONLY } from './helpers.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'compiler', 'src', 'cli', 'main.ts');
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'ts');

const SAMPLE = `#include "jsrt_value.h"

JSRT_GLOBALS(2);

static jsrt_value _jsrt_fn_0(uint32_t argc, const jsrt_value *argv, JSRTEnv *env);
static JSRTClosure _jsrt_closure_0 = {_jsrt_fn_0, 0, "f", NULL, false, NULL, false};
static JSRTIC _jsrt_ic_0;

static jsrt_value _jsrt_fn_0(uint32_t argc, const jsrt_value *argv, JSRTEnv *env) {
  return JSRT_UNDEFINED;
}

int main(int argc, char **argv) {
  return 0;
}
`;

function isFunctionOpen(line: string): boolean {
  return (
    line.endsWith(' {') &&
    line.includes('(') &&
    !line.startsWith('#') &&
    !line.startsWith('static const ')
  );
}

/** Column-0 function signatures, `static` removed, in source order. */
function functionSignatures(c: string): string[] {
  const found: string[] = [];
  let open = false;
  for (const line of c.split('\n')) {
    if (!open) {
      if (isFunctionOpen(line)) {
        found.push(line.startsWith('static ') ? line.slice('static '.length) : line);
        open = true;
      }
      continue;
    }
    if (line === '}') {
      open = false;
    }
  }
  return found;
}

function padded(functions: number, chars: number): string {
  const bodies: string[] = [];
  for (let i = 0; i < functions; i++) {
    bodies.push(`static jsrt_value _jsrt_fn_${String(i)}(void) {\n  return JSRT_UNDEFINED;\n}`);
  }
  let c = `${bodies.join('\n\n')}\n`;
  if (c.length < chars) {
    c += `/* ${'x'.repeat(chars - c.length)} */\n`;
  }
  return c;
}

test('the split thresholds are the ones TOOLCHAIN.md documents', () => {
  assert.equal(PARALLEL_MIN_FUNCTIONS, 8);
  assert.equal(PARALLEL_MIN_CHARS, 40_000);
});

test('resolveCompileJobs accepts an integer >= 1 and names a bad one', () => {
  assert.deepEqual(resolveCompileJobs('2', undefined), { ok: true, jobs: 2, explicit: true });
  assert.deepEqual(resolveCompileJobs('1', undefined), { ok: true, jobs: 1, explicit: true });
  const unset = resolveCompileJobs(undefined, undefined);
  assert.equal(unset.ok, true);
  if (unset.ok) {
    assert.equal(unset.explicit, false);
    assert.ok(unset.jobs >= 1);
  }
  const empty = resolveCompileJobs('  ', undefined);
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.explicit, false);
  }
  const override = resolveCompileJobs('1', 4);
  assert.deepEqual(override, { ok: true, jobs: 4, explicit: true });
  for (const raw of ['0', '01', '-1', '1.5', 'fast']) {
    const bad = resolveCompileJobs(raw, undefined);
    assert.equal(bad.ok, false, raw);
    if (!bad.ok) {
      assert.match(bad.message, /STATOR_COMPILE_JOBS/);
      assert.match(bad.message, /integer >= 1/);
    }
  }
});

test('shouldSplit stays serial for one job, a small implicit job count, and one function', () => {
  const two = padded(2, 100);
  assert.equal(shouldSplitTranslationUnit(two, 1, true), false);
  assert.equal(shouldSplitTranslationUnit(two, 2, true), true);
  assert.equal(shouldSplitTranslationUnit(two, 8, false), false);
  assert.equal(shouldSplitTranslationUnit(padded(PARALLEL_MIN_FUNCTIONS, 100), 8, false), false);
  assert.equal(
    shouldSplitTranslationUnit(padded(PARALLEL_MIN_FUNCTIONS, PARALLEL_MIN_CHARS), 8, false),
    true,
  );
  assert.equal(shouldSplitTranslationUnit(padded(1, PARALLEL_MIN_CHARS), 8, true), false);
});

test('partition publishes shared data once and each function in one unit', () => {
  assert.throws(() => partitionTranslationUnit(SAMPLE, 1), /nothing to split/);
  assert.throws(
    () => partitionTranslationUnit('int main(void) {\n  return 0;\n}\n', 2),
    /nothing to split/,
  );
  assert.throws(() => partitionTranslationUnit('int main(void) {\n', 2), /never closed/);

  const parts = partitionTranslationUnit(SAMPLE, 2);
  assert.equal(parts.headerName, 'stator_units.h');
  assert.match(parts.header, /#include "jsrt_value.h"/);
  assert.match(parts.header, /extern jsrt_value _jsrt_globals\[\];/);
  assert.match(parts.header, /extern JSRTFrame _jsrt_global_frame;/);
  assert.match(
    parts.header,
    /jsrt_value _jsrt_fn_0\(uint32_t argc, const jsrt_value \*argv, JSRTEnv \*env\);/,
  );
  assert.equal(parts.header.includes('static '), false);
  assert.match(parts.header, /extern JSRTClosure _jsrt_closure_0;/);
  assert.match(parts.header, /extern JSRTIC _jsrt_ic_0;/);

  const shared = parts.units[0];
  assert.ok(shared);
  assert.equal(shared.name, 'stator_shared.c');
  assert.match(shared.source, /jsrt_value _jsrt_globals\[2\];/);
  assert.match(shared.source, /JSRTFrame _jsrt_global_frame;/);
  assert.match(shared.source, /JSRTClosure _jsrt_closure_0 = \{/);
  assert.match(shared.source, /^JSRTIC _jsrt_ic_0;$/m);
  assert.equal(shared.source.includes('static '), false);
  assert.equal(functionSignatures(shared.source).length, 0);

  const units = parts.units.slice(1);
  assert.equal(units.length, 2);
  const joined = units.map((unit) => unit.source).join('\n');
  for (const signature of functionSignatures(SAMPLE)) {
    const hits = joined.split(signature).length - 1;
    assert.equal(hits, 1, signature);
  }
  assert.match(
    joined,
    /^jsrt_value _jsrt_fn_0\(uint32_t argc, const jsrt_value \*argv, JSRTEnv \*env\) \{$/m,
  );
  assert.match(joined, /^int main\(int argc, char \*\*argv\) \{$/m);
});

test('every lowered golden with two functions partitions without dropping one', () => {
  const problems: string[] = [];
  let checked = 0;
  for (const name of readdirSync(GOLDEN).sort()) {
    const path = join(GOLDEN, name);
    if (!name.endsWith('.ts') || statSync(path).isDirectory()) {
      continue;
    }
    let c: string;
    try {
      c = emitC(lowerSource(readFileSync(path, 'utf8'), path).module);
    } catch {
      // A fixture that does not lower on its own is outside this corpus, same rule as the
      // frame audit: multi-file programs and a few class graphs need the whole-program path.
      continue;
    }
    if (countTopLevelFunctions(c) < 2) {
      continue;
    }
    checked += 1;
    try {
      const parts = partitionTranslationUnit(c, 4);
      const joined = parts.units
        .slice(1)
        .map((unit) => unit.source)
        .join('\n');
      for (const signature of functionSignatures(c)) {
        const hits = joined.split(signature).length - 1;
        if (hits !== 1) {
          problems.push(`${name}: ${signature} appears ${String(hits)} times`);
        }
      }
      const shared = parts.units[0]?.source ?? '';
      if (shared.includes('static ')) {
        problems.push(`${name}: shared unit still has static`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      problems.push(`${name}: ${detail}`);
    }
  }
  assert.ok(checked > 20, `expected the golden corpus, got ${String(checked)}`);
  assert.deepEqual(problems, []);
});

test('compile jobs do not change the C --emit=c writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stator-jobs-c-'));
  try {
    const entry = join(dir, 'main.ts');
    writeFileSync(
      entry,
      'export function f(n: number): number { return n + 1; }\nconsole.log(f(2));\n',
    );
    const once = join(dir, 'once.c');
    const many = join(dir, 'many.c');
    assert.equal(
      await build({ entry, out: once, mode: 'ts', emitCOnly: true, keepC: false, compileJobs: 1 }),
      0,
    );
    assert.equal(
      await build({ entry, out: many, mode: 'ts', emitCOnly: true, keepC: false, compileJobs: 4 }),
      0,
    );
    assert.equal(readFileSync(once, 'utf8'), readFileSync(many, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an in-process compileJobs of 0 is STA0021', async () => {
  await assert.rejects(
    build({
      entry: 'missing.ts',
      out: 'missing',
      mode: 'ts',
      emitCOnly: true,
      keepC: false,
      compileJobs: 0,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BuildError);
      assert.equal(error.code, 'STA0021');
      assert.match(error.message, /integer >= 1/);
      return true;
    },
  );
});

test('STATOR_COMPILE_JOBS=0 is STA0021, and a project .env cannot set it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stator-jobs-env-'));
  try {
    const entry = join(dir, 'app.ts');
    writeFileSync(entry, 'console.log(1);\n');
    writeFileSync(join(dir, '.env'), 'STATOR_COMPILE_JOBS=nope\n');
    const ignored = await execa(
      process.execPath,
      [CLI, 'build', entry, '-o', join(dir, 'app.c'), '--emit=c'],
      {
        cwd: dir,
        reject: false,
        stripFinalNewline: false,
        extendEnv: false,
        env: { PATH: process.env['PATH'] ?? '' },
      },
    );
    assert.equal(ignored.exitCode, 0, ignored.stderr);
    assert.match(ignored.stderr, /ignored STATOR_COMPILE_JOBS/);

    const bad = await execa(
      process.execPath,
      [CLI, 'build', entry, '-o', join(dir, 'bad.c'), '--emit=c'],
      {
        cwd: dir,
        reject: false,
        stripFinalNewline: false,
        extendEnv: false,
        env: { PATH: process.env['PATH'] ?? '', STATOR_COMPILE_JOBS: '0' },
      },
    );
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /STA0021/);
    assert.match(bad.stderr, /STATOR_COMPILE_JOBS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TS_PROGRAM: Readonly<Record<string, string>> = {
  'a.ts': `export function fromA(n: number): number {
  return n + 1;
}

export class Box {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
  double(): number {
    return this.value * 2;
  }
}
`,
  'b.ts': `import { fromA } from "./a.ts";

export function fromB(n: number): number {
  return fromA(n) * 3;
}

export function scale(n: number): number {
  return n + fromB(0);
}
`,
  'main.ts': `import { Box } from "./a.ts";
import { fromB, scale } from "./b.ts";

function mainValue(n: number): number {
  return fromB(n) + scale(1);
}

function bump(n: number): number {
  return n + 1;
}

function closed(n: number): () => number {
  const base = n;
  return () => base + 1;
}

console.log(fromB(3));
console.log(new Box(4).double());
console.log(bump(5) + mainValue(1));
console.log(closed(5)());
`,
};

const JS_PROGRAM = `function bump(o) {
  o.n = o.n + 1;
  o.extra = o.n;
  return o.n;
}
const box = { n: 1 };
box.label = "b";
console.log(bump(box));
console.log(bump(box));
console.log(box.label);
console.log(box.extra);
`;

async function runBuilt(
  dir: string,
  entry: string,
  mode: 'ts' | 'js',
  jobs: number,
): Promise<string> {
  const out = join(dir, `app-${mode}-${String(jobs)}`);
  const code = await build({
    entry,
    out,
    mode,
    emitCOnly: false,
    keepC: false,
    compileJobs: jobs,
  });
  assert.equal(code, 0);
  const run = await execa(out, [], { reject: false, stripFinalNewline: false });
  assert.equal(run.exitCode, 0, run.stderr);
  return run.stdout;
}

test('jobs=1 and jobs=2 print the same bytes for a multi-file program', NATIVE_ONLY, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stator-jobs-native-'));
  try {
    for (const [name, text] of Object.entries(TS_PROGRAM)) {
      writeFileSync(join(dir, name), text);
    }
    const serial = await runBuilt(dir, join(dir, 'main.ts'), 'ts', 1);
    const parallel = await runBuilt(dir, join(dir, 'main.ts'), 'ts', 2);
    assert.equal(parallel, serial);
    assert.equal(serial, '12\n8\n16\n6\n');

    const jsEntry = join(dir, 'dyn.js');
    writeFileSync(jsEntry, JS_PROGRAM);
    const jsSerial = await runBuilt(dir, jsEntry, 'js', 1);
    const jsParallel = await runBuilt(dir, jsEntry, 'js', 2);
    assert.equal(jsParallel, jsSerial);
    assert.equal(jsSerial, '2\n3\nb\n3\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
