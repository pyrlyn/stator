/* The SQLite-demo C-consumer runner (plan.md §10 Task 7.3 Check) — builds
 * `examples/ffi/sqlite/demo.ts` with `--emit-header` (NO main, `--unit-name sqlitedemo`),
 * double-builds the header and byte-compares it (Task 7.2 step 8's determinism rule),
 * links `main.c` against the object and `libjsrt.a` plus `-lsqlite3` under the same
 * C11 -Wall -Wextra -Werror discipline as the runtime, runs the app, and byte-compares
 * stdout against `expected-c.txt`. Deterministic, no new dependencies.
 *
 * Runner mechanics (fail/run/link) live in `../shared.ts`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI,
  RUNTIME_ARCHIVE,
  RUNTIME_LIB_DIR,
  archiveSystemFlags,
  expectOutput,
  linkConsumer,
  makeFail,
  run,
  type Fail,
} from '../../../packages/tests/support/c-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const RUNTIME_INCLUDE = join(ROOT, 'packages', 'runtime', 'include');

const fail: Fail = makeFail('ffi sqlite-c-main');

function main(): void {
  if (!existsSync(RUNTIME_ARCHIVE)) {
    fail(`runtime archive missing at ${RUNTIME_ARCHIVE} — run the runtime recipe first`);
  }
  const demo = join(HERE, 'demo.ts');
  if (!existsSync(demo)) {
    fail(`demo unit missing at ${demo} — the TS track has not landed yet`);
  }
  const sysFlags = archiveSystemFlags(RUNTIME_LIB_DIR, fail);
  const work = mkdtempSync(join(tmpdir(), 'stator-sqlite-c-main-'));
  try {
    const first = join(work, 'sqlitedemo.h');
    const second = join(work, 'sqlitedemo2.h');
    const obj = join(work, 'demo.o');
    run(
      process.execPath,
      [CLI, 'build', demo, '-o', obj, '--emit-header', first, '--unit-name', 'sqlitedemo'],
      'stator build (first)',
      fail,
    );
    run(
      process.execPath,
      [
        CLI,
        'build',
        demo,
        '-o',
        join(work, 'demo2.o'),
        `--emit-header=${second}`,
        '--unit-name',
        'sqlitedemo',
      ],
      'stator build (second)',
      fail,
    );
    if (!readFileSync(first).equals(readFileSync(second))) {
      fail('same input emitted byte-different headers');
    }
    const app = join(work, 'app');
    const linkArgs: readonly string[] = [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-I',
      RUNTIME_INCLUDE,
      '-I',
      work,
      join(HERE, 'main.c'),
      obj,
      '-L',
      RUNTIME_LIB_DIR,
      '-ljsrt',
      ...sysFlags,
      '-lsqlite3',
      '-o',
      app,
    ];
    linkConsumer('clang', linkArgs, fail);
    const output = run(app, [], 'sqlite demo app', fail);
    const expected = readFileSync(join(HERE, 'expected-c.txt'), 'utf8');
    expectOutput('', output, expected, fail);
    process.stdout.write('ffi sqlite-c-main: ok\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
