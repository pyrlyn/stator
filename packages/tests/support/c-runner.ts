/* Shared runner mechanics for the `examples/ffi/` programs and the FFI C-consumer
 * (plan.md §10 Task 7.3): fail-with-prefix, spawn-checked `run`, the recorded
 * `link-flags.txt` reader, and the consumer-side clang link with the stale-linker retry.
 * Extracted — not copied a third time — when the libm/stat/sqlite runners grew the same
 * helpers as the C-consumer (AGENTS.md: one shared helper at the responsible layer).
 * Each runner keeps its own CLI/archive paths, expected files, and report lines; only the
 * mechanics are shared, so a behavior change here is visible in every example at once.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleLdRetryArgs } from '../../compiler/src/support/toolchain.ts';

export type Fail = (message: string) => never;

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The compiler CLI every runner builds with, and the runtime it links against. */
export const CLI = join(PACKAGES, 'compiler', 'src', 'cli', 'main.ts');
export const RUNTIME_LIB_DIR = join(PACKAGES, 'runtime', 'build');
export const RUNTIME_ARCHIVE = join(RUNTIME_LIB_DIR, 'libjsrt.a');

/** A `FAIL` that names its runner: `makeFail('ffi sqlite-c-main')` writes
 * `ffi sqlite-c-main: FAIL ...` and exits nonzero. */
export function makeFail(prefix: string): Fail {
  return (message: string): never => {
    process.stderr.write(`${prefix}: FAIL ${message}\n`);
    process.exit(1);
  };
}

/** Fails unless `actual` is `expected` byte for byte; `side` names whose output it is
 * (`stator`, `node`), or is empty when there is only one. */
export function expectOutput(side: string, actual: string, expected: string, fail: Fail): void {
  if (actual === expected) {
    return;
  }
  const who = side === '' ? '' : `${side} `;
  fail(
    `${who}output differs\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
  );
}

export function run(
  command: string,
  args: readonly string[],
  what: string,
  fail: Fail,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, [...args], { encoding: 'utf8', env });
  if (result.status !== 0) {
    fail(`${what} exited ${String(result.status)}:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

/** The archive's own system dependencies, recorded beside it by the just recipe that built
 * it — the same flags `linkExecutable` reads, so a hand link is the link a user gets. */
export function archiveSystemFlags(runtimeLibDir: string, fail: Fail): string[] {
  const recorded = `${runtimeLibDir}/link-flags.txt`;
  if (!existsSync(recorded)) {
    fail(`runtime archive flags missing at ${recorded} — run the runtime recipe first`);
  }
  const flags = readFileSync(recorded, 'utf8').trim();
  return flags === '' ? [] : flags.split(/\s+/);
}

/** A consumer-side clang link (docs/FFI.md §8 step 9): one attempt, then the shared
 * stale-linker retry under the newest readable CLT SDK (the same fallback `build.ts`
 * link() applies — a stale bundled ld against a newer Xcode SDK fails here identically).
 * `cc` is the compiler name (`clang` unless the caller tests another toolchain). */
export function linkConsumer(cc: string, args: readonly string[], fail: Fail): void {
  const first = spawnSync(cc, [...args], { encoding: 'utf8' });
  if (first.status === 0) {
    return;
  }
  const retry = staleLdRetryArgs(args, first.stderr, {
    darwin: process.platform === 'darwin',
    defaultCc: true,
    sanitized: false,
  });
  if (retry === undefined) {
    fail(`clang link exited ${String(first.status)}:\n${first.stdout}${first.stderr}`);
  }
  run(cc, retry.args, 'clang link', fail);
}
