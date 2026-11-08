/* The `stator-engine` binary the engine harnesses run (run.ts, bench.ts; docs/ENGINE.md §5). */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..', '..');
const ENGINE = join(REPO, 'packages', 'engine');

/**
 * Builds the requested host; `STATOR_ENGINE` (CLI) or `STATOR_STEADY` (benchmark) can name a
 * prebuilt binary. Both link `packages/runtime/build/libjsrt.a`; `pnpm run runtime` comes first.
 */
export function engineBinary(
  optimize: 'Debug' | 'ReleaseSafe' | 'ReleaseFast',
  target: 'cli' | 'steady' = 'cli',
): string {
  const prebuilt = process.env[target === 'cli' ? 'STATOR_ENGINE' : 'STATOR_STEADY'];
  if (prebuilt !== undefined && prebuilt !== '') return prebuilt;
  execFileSync(
    'zig',
    ['build', target, `-Doptimize=${optimize}`, '--build-file', join(ENGINE, 'build.zig')],
    { cwd: ENGINE, stdio: 'inherit' },
  );
  return join(
    ENGINE,
    'zig-out',
    'bin',
    `${target === 'cli' ? 'stator-engine' : 'stator-steady'}${process.platform === 'win32' ? '.exe' : ''}`,
  );
}
