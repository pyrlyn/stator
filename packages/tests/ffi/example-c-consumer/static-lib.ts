/* Task 7.4 Check (plan.md §10): `--emit=lib` gives a C build everything it needs in three files.
 *
 * - `unit.ts` builds to `libconsumer.a` + `consumer.h` + `libconsumer.pc` twice, and the two
 *   builds must be byte-identical (the archive only in the default flavor: the sanitized one
 *   compiles with `-g`, whose debug map names the scratch directory).
 * - The three files and `main.c` are copied to a fresh directory, must hold no path into this
 *   repository (but the unit's own error-stack locations), and `main.c` links through `pkg-config --cflags --libs libconsumer` alone, runs,
 *   and prints `expected.txt`.
 * - `keeper.ts` builds to a second library, and `two.c` links BOTH into one program: two private
 *   runtimes, each with its own collector, run under `JSRT_GC_STRESS=1` so both collect on
 *   every allocation (plan-notes 341, 342; plan/T66).
 *
 * `STATOR_RUNTIME=asan` (the ASan gate's stage) builds against the sanitized runtime; the
 * libraries then carry `-fsanitize` in their `.pc`, so the consumer link is unchanged.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime, selectCC } from '../../../compiler/src/cli/build.ts';
import { linkConsumer, makeFail, run, type Fail } from '../../support/c-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const CLI = join(HERE, '..', '..', '..', 'compiler', 'src', 'cli', 'main.ts');
const RUNTIME = resolveRuntime();
const SANITIZED = RUNTIME.sanitized;

const fail: Fail = makeFail('ffi static-lib');

/** `stator build --emit=lib` of `source` as unit `unit` into `dir`. */
function buildLibrary(source: string, unit: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  run(
    process.execPath,
    [
      CLI,
      'build',
      join(HERE, source),
      '--emit=lib',
      '-o',
      join(dir, `lib${unit}.a`),
      `--emit-header=${join(dir, `${unit}.h`)}`,
      '--unit-name',
      unit,
    ],
    `stator build --emit=lib (${unit})`,
    fail,
  );
}

/** The files a consumer is handed, by name. */
function libraryFiles(unit: string): string[] {
  return [`lib${unit}.a`, `${unit}.h`, `lib${unit}.pc`];
}

/** Copies `unit`'s three files to `to`, refusing any that names this repository. The one path
 * allowed is the unit's own source, which a call site's error-stack location names exactly as it
 * does in a binary (`file:line`, docs/FFI.md §8); nothing the consumer's build reads. */
function deliver(from: string, unit: string, source: string, to: string): void {
  for (const name of libraryFiles(unit)) {
    copyFileSync(join(from, name), join(to, name));
    // The sanitized archive's debug info names the runtime's sources; that flavor is a test
    // build, never one handed to a consumer.
    if (SANITIZED && name.endsWith('.a')) {
      continue;
    }
    const text = readFileSync(join(to, name), 'latin1').replaceAll(`${join(HERE, source)}:`, '');
    if (text.includes(REPO)) {
      fail(`${name} names the repository path ${REPO}`);
    }
  }
}

function pkgConfig(dir: string, names: readonly string[]): string[] {
  const result = spawnSync('pkg-config', ['--cflags', '--libs', ...names], {
    encoding: 'utf8',
    env: { ...process.env, PKG_CONFIG_PATH: dir },
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(
      `pkg-config ${names.join(' ')} failed (is pkg-config installed?):\n` +
        `${result.stderr ?? ''}${result.error?.message ?? ''}`,
    );
  }
  return result.stdout.trim().split(/\s+/);
}

/** Links `source` in `dir` against the named libraries through pkg-config only, runs it, and
 * returns its stdout. `stress` runs it with a collection on every allocation. */
function linkAndRun(dir: string, source: string, names: readonly string[], stress = false): string {
  const flags = pkgConfig(dir, names);
  const app = join(dir, source.replace(/\.c$/, ''));
  linkConsumer(
    selectCC(RUNTIME),
    ['-std=c11', '-Wall', '-Wextra', '-Werror', join(dir, source), ...flags, '-o', app],
    fail,
  );
  return run(app, [], source, fail, stress ? { ...process.env, JSRT_GC_STRESS: '1' } : process.env);
}

function main(): void {
  const work = mkdtempSync(join(tmpdir(), 'stator-static-lib-'));
  try {
    const first = join(work, 'first');
    const second = join(work, 'second');
    buildLibrary('unit.ts', 'consumer', first);
    buildLibrary('unit.ts', 'consumer', second);
    for (const name of libraryFiles('consumer')) {
      if (SANITIZED && name.endsWith('.a')) {
        continue;
      }
      if (!readFileSync(join(first, name)).equals(readFileSync(join(second, name)))) {
        fail(`two builds of the same input gave byte-different ${name}`);
      }
    }
    buildLibrary('keeper.ts', 'keeper', join(work, 'keeper'));

    const consumer = join(work, 'consumer-app');
    mkdirSync(consumer);
    deliver(first, 'consumer', 'unit.ts', consumer);
    copyFileSync(join(HERE, 'main.c'), join(consumer, 'main.c'));
    const one = linkAndRun(consumer, 'main.c', ['libconsumer']);
    const expected = readFileSync(join(HERE, 'expected.txt'), 'utf8');
    if (one !== expected) {
      fail(
        `output differs\n  actual:   ${JSON.stringify(one)}\n` +
          `  expected: ${JSON.stringify(expected)}`,
      );
    }

    const both = join(work, 'two-app');
    mkdirSync(both);
    deliver(first, 'consumer', 'unit.ts', both);
    deliver(join(work, 'keeper'), 'keeper', 'keeper.ts', both);
    copyFileSync(join(HERE, 'two.c'), join(both, 'two.c'));
    const two = linkAndRun(both, 'two.c', ['libconsumer', 'libkeeper'], true);
    if (two !== 'keeper=5000\ntwo libraries ok\n') {
      fail(`two-library output differs: ${JSON.stringify(two)}`);
    }
    process.stdout.write(
      `ffi static-lib: ok (${SANITIZED ? 'asan, ' : ''}two libraries, ` +
        'two collectors collecting on every allocation)\n',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
