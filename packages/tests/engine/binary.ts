/* The `stator-engine` binary the engine harnesses run (run.ts, bench.ts; docs/ENGINE.md §5). */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..', '..');
const ENGINE = join(REPO, 'packages', 'engine');

/**
 * Builds the CLI with `optimize` and answers its path; `STATOR_ENGINE` names a prebuilt binary
 * instead. The build links `packages/runtime/build/libjsrt.a`, so `pnpm run runtime` comes first.
 */
export function engineBinary(optimize: 'Debug' | 'ReleaseSafe' | 'ReleaseFast'): string {
  const prebuilt = process.env['STATOR_ENGINE'];
  if (prebuilt !== undefined && prebuilt !== '') return prebuilt;
  execFileSync(
    'zig',
    ['build', 'cli', `-Doptimize=${optimize}`, '--build-file', join(ENGINE, 'build.zig')],
    { cwd: ENGINE, stdio: 'inherit' },
  );
  return join(
    ENGINE,
    'zig-out',
    'bin',
    process.platform === 'win32' ? 'stator-engine.exe' : 'stator-engine',
  );
}
