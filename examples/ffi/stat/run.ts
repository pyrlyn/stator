/* Struct-by-pointer step-1 example runner (plan.md §10 Task 7.3 step 1) —
 * compiles the demo-local accessor shim (`stat_shim.c`) through the fixture-C
 * path (same C11 `-Wall -Wextra -Werror` discipline as the golden fixtures),
 * builds `main.ts` with stator (the shim object rides `--link=`; the header
 * rides the `@statorLink` pragma in `stat_shim.d.ts`), prepares `data.bin`
 * with fixed bytes AND a fixed mtime, and byte-compares the binary AND this
 * host's Node (via `node_shim.ts`) against `expected.txt`. Deterministic,
 * offline, no new dependencies.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', '..', 'packages', 'compiler', 'src', 'cli', 'main.ts');
const RUNTIME_LIB_DIR = join(HERE, '..', '..', '..', 'packages', 'runtime', 'build');
const RUNTIME_ARCHIVE = join(RUNTIME_LIB_DIR, 'libjsrt.a');

/* Fixed mtime both sides must agree on (whole seconds: the shim returns
 * `(double)st.st_mtime`, the mirror floors `mtimeMs / 1000`). */
const MTIME = 1700000000;

function fail(message: string): never {
  process.stderr.write(`ffi stat example: FAIL ${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[], what: string, cwd?: string): string {
  const result = spawnSync(command, [...args], { encoding: 'utf8', cwd });
  if (result.status !== 0) {
    fail(`${what} exited ${String(result.status)}:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

function main(): void {
  if (!existsSync(RUNTIME_ARCHIVE)) {
    fail(`runtime archive missing at ${RUNTIME_ARCHIVE} — run the runtime recipe first`);
  }
  const work = mkdtempSync(join(tmpdir(), 'stator-ffi-stat-'));
  try {
    const cc = process.env['CC'] ?? 'clang';
    const shimObj = join(work, 'stat_shim.c.o');
    run(
      cc,
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-c',
        join(HERE, 'stat_shim.c'),
        '-o',
        shimObj,
      ],
      'fixture C',
    );
    const app = join(work, 'app');
    run(
      process.execPath,
      [CLI, 'build', join(HERE, 'main.ts'), '-o', app, '--mode', 'ts', '--link', shimObj],
      'stator build',
    );
    const expected = readFileSync(join(HERE, 'expected.txt'), 'utf8');
    // Both sides resolve the relative path against this directory: fixed
    // bytes (8) and a fixed mtime pin both outputs.
    const data = join(work, 'data.bin');
    writeFileSync(data, 'stator01');
    utimesSync(data, MTIME, MTIME);
    const statorOut = run(app, [], 'example app', work);
    if (statorOut !== expected) {
      fail(
        `stator output differs\n  actual:   ${JSON.stringify(statorOut)}\n  expected: ${JSON.stringify(expected)}`,
      );
    }
    const nodeOut = run(
      process.execPath,
      ['--import', join(HERE, 'node_shim.ts'), join(HERE, 'main.ts')],
      'node oracle',
      work,
    );
    if (nodeOut !== expected) {
      fail(
        `node output differs\n  actual:   ${JSON.stringify(nodeOut)}\n  expected: ${JSON.stringify(expected)}`,
      );
    }
    process.stdout.write('ffi stat example: ok\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
