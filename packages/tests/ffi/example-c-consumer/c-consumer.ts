/* Task 7.2 step 9: the CI example runner (plan.md §10) — builds `unit.ts` with
 * `--emit-header` (NO main), double-builds the header and byte-compares it (step 8's
 * determinism rule), links `main.c` against the object and `libjsrt.a` under the same
 * C11 -Wall -Wextra -Werror discipline as the runtime, runs the app, and byte-compares
 * stdout against `expected.txt`. Deterministic, offline, no new dependencies.
 *
 * This is a smoke example, not a second suite: the init/throws/frame contract itself is
 * pinned in `tests/unit/export-stubs.test.ts`, which this file must not duplicate.
 * Runner mechanics (fail/run/link) live in `examples/ffi/shared.ts`.
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
} from '../../support/c-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_INCLUDE = join(HERE, '..', '..', '..', 'runtime', 'include');

const fail: Fail = makeFail('ffi c-consumer');

function main(): void {
  if (!existsSync(RUNTIME_ARCHIVE)) {
    fail(`runtime archive missing at ${RUNTIME_ARCHIVE} — run the runtime recipe first`);
  }
  const sysFlags = archiveSystemFlags(RUNTIME_LIB_DIR, fail);
  const work = mkdtempSync(join(tmpdir(), 'stator-c-consumer-'));
  try {
    const first = join(work, 'consumer.h');
    const second = join(work, 'consumer2.h');
    const obj = join(work, 'unit.o');
    run(
      process.execPath,
      [
        CLI,
        'build',
        join(HERE, 'unit.ts'),
        '-o',
        obj,
        '--emit-header',
        first,
        '--unit-name',
        'consumer',
      ],
      'stator build (first)',
      fail,
    );
    run(
      process.execPath,
      [
        CLI,
        'build',
        join(HERE, 'unit.ts'),
        '-o',
        join(work, 'unit2.o'),
        `--emit-header=${second}`,
        '--unit-name',
        'consumer',
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
      '-o',
      app,
    ];
    linkConsumer('clang', linkArgs, fail);
    const output = run(app, [], 'consumer app', fail);
    const expected = readFileSync(join(HERE, 'expected.txt'), 'utf8');
    expectOutput('', output, expected, fail);
    process.stdout.write('ffi c-consumer: ok\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
