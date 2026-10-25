/* `STATOR_COMPILE_JOBS` (plan.md §11b T10.3): resolution, the split threshold, and the
 * partition. The pure pieces are pinned so a regression cannot silently change what gets split;
 * the last test builds the multi-module `modules` fixture under `STATOR_COMPILE_JOBS=2` so a
 * shared-state race in the parallel clang path fails the unit gate (T10.3 step 5). */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import {
  PARALLEL_MIN_CHARS,
  PARALLEL_MIN_FUNCTIONS,
  countTopLevelFunctions,
  partitionTranslationUnit,
  resolveCompileJobs,
  shouldSplitTranslationUnit,
} from '../../compiler/src/cli/compile-jobs.ts';
import { NATIVE_ONLY } from './helpers.ts';

const PREAMBLE = ['#include <jsrt.h>', '', 'JSRT_GLOBALS(2);', '', 'static jsrt_value g;'].join(
  '\n',
);

function fn(name: string, bodyLines: number): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `  x += ${String(i)};`).join('\n');
  return `jsrt_value ${name}(jsrt_value x) {\n${body}\n  return x;\n}`;
}

function program(functions: number, bodyLines: number, pad = 0): string {
  const fns = Array.from({ length: functions }, (_, i) => fn(`f${String(i)}`, bodyLines)).join(
    '\n\n',
  );
  return `${PREAMBLE}\n\n${fns}\n${' '.repeat(pad)}\n`;
}

describe('resolveCompileJobs', () => {
  it('unset defaults to host parallelism without marking explicit', () => {
    const r = resolveCompileJobs(undefined, undefined);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.explicit, false);
      assert.ok(r.jobs >= 1);
    }
  });

  it('a positive integer is explicit', () => {
    const r = resolveCompileJobs('4', undefined);
    assert.deepEqual(r, { ok: true, jobs: 4, explicit: true });
  });

  it('the in-process override wins over the environment', () => {
    const r = resolveCompileJobs('8', 2);
    assert.deepEqual(r, { ok: true, jobs: 2, explicit: true });
  });

  it('blank is unset, the same as a missing variable', () => {
    const r = resolveCompileJobs('   ', undefined);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.explicit, false);
    }
  });

  for (const bad of ['0', '-1', '1.5', 'abc']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      const r = resolveCompileJobs(bad, undefined);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.match(r.message, /STATOR_COMPILE_JOBS/);
      }
    });
  }
});

describe('shouldSplitTranslationUnit', () => {
  it('jobs=1 never splits', () => {
    assert.equal(shouldSplitTranslationUnit(program(20, 40), 1, true), false);
    assert.equal(shouldSplitTranslationUnit(program(20, 40), 1, false), false);
  });

  it('fewer than two functions never splits', () => {
    assert.equal(shouldSplitTranslationUnit(program(1, 40), 8, true), false);
  });

  it('an explicit value above 1 splits at two functions', () => {
    assert.equal(shouldSplitTranslationUnit(program(2, 3), 2, true), true);
  });

  it('the default needs both thresholds', () => {
    const small = program(4, 3);
    assert.equal(shouldSplitTranslationUnit(small, 8, false), false);
    const manyFns = program(PARALLEL_MIN_FUNCTIONS, 1);
    assert.equal(shouldSplitTranslationUnit(manyFns, 8, false), false);
    const big = program(PARALLEL_MIN_FUNCTIONS, 200, PARALLEL_MIN_CHARS);
    assert.equal(shouldSplitTranslationUnit(big, 8, false), true);
  });
});

describe('partitionTranslationUnit', () => {
  it('writes a shared unit plus one unit per bucket of functions', () => {
    const parts = partitionTranslationUnit(program(6, 4), 3);
    assert.equal(parts.headerName, 'stator_units.h');
    assert.match(parts.header, /#ifndef STATOR_UNITS_H/);
    assert.match(parts.header, /extern jsrt_value _jsrt_globals\[\];/);
    const names = parts.units.map((u) => u.name);
    assert.equal(names[0], 'stator_shared.c');
    // shared + one unit per bucket (buckets = min(jobs, functions) = 3).
    assert.equal(parts.units.length, 4);
    for (const unit of parts.units.slice(1)) {
      assert.match(unit.source, /#include "stator_units.h"/);
    }
    // Every function appears exactly once across the function units, published non-static.
    const joined = parts.units.map((u) => u.source).join('\n');
    for (let i = 0; i < 6; i++) {
      assert.equal(joined.split(`f${String(i)}(`).length - 1, 1);
    }
    assert.equal(joined.includes('static jsrt_value f0'), false);
  });

  it('countTopLevelFunctions walks the emitter layout', () => {
    assert.equal(countTopLevelFunctions(program(3, 2)), 3);
    assert.equal(countTopLevelFunctions(PREAMBLE), 0);
  });

  it('refuses to split a program with fewer than two functions', () => {
    assert.throws(() => partitionTranslationUnit(program(1, 2), 4), /nothing to split/);
  });

  // `_jsrt_module_done` is defined and then used, with no preamble prototype. Bucketing
  // reorders by size, so the call can precede the definition or land in another unit.
  it('publishes a prototype for a function the emitter does not forward-declare', () => {
    const c = `static void _jsrt_module_done(void *state, jsrt_value value, bool rejected) {
  (void)state;
  (void)value;
  if (rejected) {
    return;
  }
}

int main(int argc, char **argv) {
  jsrt_promise_subscribe(JSRT_LOCAL(0), _jsrt_module_done, NULL);
  return 0;
}
`;
    const parts = partitionTranslationUnit(c, 2);
    assert.match(
      parts.header,
      /^void _jsrt_module_done\(void \*state, jsrt_value value, bool rejected\);$/m,
    );
    assert.match(parts.header, /^int main\(int argc, char \*\*argv\);$/m);
    assert.equal(parts.header.includes('if (rejected)'), false);
    assert.equal(parts.header.includes('static '), false);
    const defining = parts.units.find((unit) => unit.source.includes('_jsrt_module_done('));
    assert.ok(defining);
    assert.match(
      defining.source,
      /^void _jsrt_module_done\(void \*state, jsrt_value value, bool rejected\) \{$/m,
    );
  });
});

/* T10.3 step 5: the CI smoke that makes a race in the parallel clang path fail the build. The
 * fixture is the golden `ts/modules` graph (three modules, several top-level functions) — more
 * than the two-function floor an explicit `STATOR_COMPILE_JOBS=2` needs to split. */
describe('STATOR_COMPILE_JOBS=2 smoke', () => {
  it(
    'builds and runs the multi-module golden fixture',
    { ...NATIVE_ONLY, timeout: 120_000 },
    () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const entry = join(here, '..', 'golden', 'ts', 'modules', 'main.ts');
      assert.ok(existsSync(entry), `fixture missing: ${entry}`);
      const cli = join(here, '..', '..', 'compiler', 'src', 'cli', 'main.ts');
      const outDir = mkdtempSync(join(tmpdir(), 'stator-compile-jobs-'));
      try {
        const binary = join(outDir, 'modules');
        const build = spawnSync(
          process.execPath,
          [cli, 'build', entry, '-o', binary, '--mode=ts'],
          {
            encoding: 'utf8',
            env: { ...process.env, STATOR_COMPILE_JOBS: '2' },
          },
        );
        assert.equal(build.status, 0, `build failed:\n${build.stdout}${build.stderr}`);
        const run = spawnSync(binary, [], { encoding: 'utf8' });
        assert.equal(run.status, 0, `run failed:\n${run.stdout}${run.stderr}`);
        assert.equal(run.stdout, 'init c\ninit b\ninit a\n30\nbase=20\n');
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
  );
});
