/** The C compiler a build runs (plan/T35): one resolver, one `--version` probe, one flag table.
 *
 * Precedence: `--cc` > `CC` > config `cc` > `clang`, the order `STATOR_OPT` and `opt` already
 * follow: whoever runs the build overrides what the project file names (creator's decision,
 * plan-notes 409). Every failure is `STA0022`, naming the value, where it
 * came from and how to choose another. The host facts and the `--version` run come in from
 * `build.ts`, so this module stays free of process and file-system access.
 */

import { BuildError } from '../support/diagnostics.ts';

export type CcSource = '--cc' | 'config' | 'CC' | 'default';

export interface CcChoice {
  readonly command: string;
  readonly source: CcSource;
}

export type CcFamily = 'clang' | 'apple-clang' | 'gcc';

export interface CCompiler extends CcChoice {
  readonly family: CcFamily;
}

export const DEFAULT_CC = 'clang';

const FIX =
  'choose another with --cc=<name|path>, config "cc" or CC (unset all three for the default clang)';

/** How a diagnostic names where the value came from. */
export function describeSource(source: CcSource): string {
  switch (source) {
    case '--cc':
      return '--cc';
    case 'config':
      return 'config "cc"';
    case 'CC':
      return 'CC';
    case 'default':
      return 'the default';
  }
}

export interface CcHost {
  readonly darwin: boolean;
  readonly systemClang: boolean;
}

export interface ChosenCC {
  readonly choice: CcChoice;
  readonly warning?: string;
}

/** The resolved choice, and a warning when an explicit choice skips the ASan override.
 *
 * conda-clang 21.1.8's Darwin ASan runtime deadlocks during dyld's early malloc initialization,
 * so a sanitized build on macOS defaults to `/usr/bin/clang`, as the runtime justfile does. An
 * explicit choice is never second-guessed: it may be the toolchain under test. */
export function chooseCC(
  explicit: CcChoice | undefined,
  env: Readonly<Record<string, string | undefined>>,
  sanitized: boolean,
  host: CcHost,
): ChosenCC {
  const fromEnv = env['CC'];
  const choice: CcChoice | undefined =
    explicit?.source === '--cc'
      ? explicit
      : fromEnv !== undefined && fromEnv !== ''
        ? { command: fromEnv, source: 'CC' }
        : explicit;
  const overridden = sanitized && host.darwin && host.systemClang;
  if (choice === undefined) {
    return {
      choice: { command: overridden ? '/usr/bin/clang' : DEFAULT_CC, source: 'default' },
    };
  }
  if (!overridden) {
    return { choice };
  }
  return {
    choice,
    warning:
      `C compiler "${choice.command}" (from ${describeSource(choice.source)}) is used under ` +
      'the ASan runtime instead of /usr/bin/clang; conda clang 21.1.8 deadlocks there at startup',
  };
}

/** The family a `--version` text names, or undefined for one Stator does not know. `zig cc`
 * prints clang's banner, and is clang. */
export function classifyCompiler(version: string): CcFamily | undefined {
  if (/^Apple clang version /m.test(version)) {
    return 'apple-clang';
  }
  if (/\bclang version \d/.test(version)) {
    return 'clang';
  }
  if (/Free Software Foundation/.test(version) || /^\S*\bg?cc(-\d+)? \(.*\) \d/m.test(version)) {
    return 'gcc';
  }
  return undefined;
}

export interface VersionRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: unknown;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** One probe per command per process: a build's compile, link and prelink all ask. */
const detected = new Map<string, CcFamily>();

/** Runs `<cc> --version` and classifies it, or refuses the choice with STA0022. */
export function detectCC(choice: CcChoice, run: (command: string) => VersionRun): CCompiler {
  const known = detected.get(choice.command);
  if (known !== undefined) {
    return { ...choice, family: known };
  }
  const named = `C compiler "${choice.command}" (from ${describeSource(choice.source)})`;
  const result = run(choice.command);
  if (errorCode(result.error) === 'ENOENT') {
    throw new BuildError(
      'STA0022',
      `${named} not found — install it (clang: \`mise install\`, macOS: ` +
        `\`xcode-select --install\`, Debian/Ubuntu: \`apt install clang\`), or ${FIX}`,
    );
  }
  if (result.error !== undefined || result.status !== 0) {
    const why =
      result.error instanceof Error
        ? result.error.message
        : `exit ${String(result.status ?? 'signal')}`;
    throw new BuildError('STA0022', `${named} failed \`--version\` (${why}) — ${FIX}`);
  }
  const family = classifyCompiler(result.stdout);
  if (family === undefined) {
    const end = result.stdout.indexOf('\n');
    const banner = (end < 0 ? result.stdout : result.stdout.slice(0, end)).trim();
    throw new BuildError(
      'STA0022',
      `${named} is not clang, Apple clang or gcc: \`--version\` printed "${banner}" — ${FIX}`,
    );
  }
  detected.set(choice.command, family);
  return { ...choice, family };
}

/** Flags a family lacks, by prefix. Everything else Stator passes (`-std=c11`, `-O<n>`, `-g`,
 * `-fsanitize=address,undefined`, the section and dead-strip flags) all three accept. */
const REFUSED: Readonly<
  Record<CcFamily, readonly { readonly flag: string; readonly why: string }[]>
> = {
  clang: [],
  'apple-clang': [],
  gcc: [
    { flag: '-flto=thin', why: 'ThinLTO is LLVM-only, and the objects it made are LLVM bitcode' },
  ],
};

/** Refuses, by name, a flag `cc`'s family lacks instead of handing it over. `origin` says where
 * the flag came from and how to drop it. */
export function requireFlagsSupported(
  cc: CCompiler,
  flags: readonly string[],
  origin: string,
  fix: string,
): void {
  for (const flag of flags) {
    const refused = REFUSED[cc.family].find((entry) => flag === entry.flag);
    if (refused !== undefined) {
      throw new BuildError(
        'STA0022',
        `C compiler "${cc.command}" (${cc.family}, from ${describeSource(cc.source)}) does not ` +
          `take ${flag}, which ${origin} asks for (${refused.why}) — ${fix}`,
      );
    }
  }
}
