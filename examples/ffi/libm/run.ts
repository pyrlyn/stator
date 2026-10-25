/* libm step-1 example runner (plan.md §10 Task 7.3 step 1) — builds `main.ts`
 * with stator, runs the binary AND this host's Node (via `node_shim.ts`, the
 * golden runner's `--import` pattern), and byte-compares both against
 * `expected.txt`. Deterministic, offline, no new dependencies. libm needs no
 * link pragma: `-lm` rides every link inside the runtime's `link-flags.txt`.
 * (The stale-linker retry lives inside `build.ts` link(), so a plain spawn is
 * the whole build here — unlike the c-consumer's hand link, which retries.)
 * Runner mechanics (fail/run) live in `../shared.ts`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFail, run, type Fail } from '../../../packages/tests/support/c-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', '..', 'packages', 'compiler', 'src', 'cli', 'main.ts');
const RUNTIME_LIB_DIR = join(HERE, '..', '..', '..', 'packages', 'runtime', 'build');
const RUNTIME_ARCHIVE = join(RUNTIME_LIB_DIR, 'libjsrt.a');

const fail: Fail = makeFail('ffi libm example');

function main(): void {
  if (!existsSync(RUNTIME_ARCHIVE)) {
    fail(`runtime archive missing at ${RUNTIME_ARCHIVE} — run the runtime recipe first`);
  }
  const work = mkdtempSync(join(tmpdir(), 'stator-ffi-libm-'));
  try {
    const app = join(work, 'app');
    run(
      process.execPath,
      [CLI, 'build', join(HERE, 'main.ts'), '-o', app, '--mode', 'ts'],
      'stator build',
      fail,
    );
    const expected = readFileSync(join(HERE, 'expected.txt'), 'utf8');
    const statorOut = run(app, [], 'example app', fail);
    if (statorOut !== expected) {
      fail(
        `stator output differs\n  actual:   ${JSON.stringify(statorOut)}\n  expected: ${JSON.stringify(expected)}`,
      );
    }
    const nodeOut = run(
      process.execPath,
      ['--import', join(HERE, 'node_shim.ts'), join(HERE, 'main.ts')],
      'node oracle',
      fail,
    );
    if (nodeOut !== expected) {
      fail(
        `node output differs\n  actual:   ${JSON.stringify(nodeOut)}\n  expected: ${JSON.stringify(expected)}`,
      );
    }
    process.stdout.write('ffi libm example: ok\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
