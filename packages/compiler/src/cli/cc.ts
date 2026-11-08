/** The C compiler a build runs (plan/T35): one resolver, one `--version` probe, one flag table.
 *
 * Precedence: `--cc` > `CC` > config `cc` > the default, the order `STATOR_OPT` and `opt` already
 * follow: whoever runs the build overrides what the project file names (creator's decision,
 * plan-notes 409). The default is the clang mise pins, never whichever `clang` PATH finds first
 * (plan-notes 410). Every failure is `STA0022`, naming the value, where it came from and how to
 * choose another. The host facts and every process run come in from `build.ts`, so this module
 * stays free of process and file-system access.
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

/** mise.toml's `conda:clang` pin. statorc runs outside a Stator checkout too, where mise.toml is
 * not there to read, so the version lives here and a unit test fails when the two drift. */
export const PINNED_CLANG_TOOL = 'conda:clang@21.1.8';

/** The default on Windows, where mise.toml pins no clang: the `clang` on PATH. */
export const WINDOWS_DEFAULT_CC = 'clang';

const CHOOSE = 'choose another with --cc=<name|path>, config "cc" or CC';
const FIX = `${CHOOSE} (unset all three for the default clang)`;

/** The arguments that ask mise for the pinned clang's absolute path. */
export const PINNED_CLANG_QUERY: readonly string[] = [
  'which',
  'clang',
  '--tool',
  PINNED_CLANG_TOOL,
];

/** The pinned clang's path from `mise which` (run by the caller), or STA0022 when mise is missing
 * or the tool is not installed. No fallback to another clang: a build that silently used a
 * different compiler would not be the build the project tested. */
export function pinnedClang(run: (command: string, args: readonly string[]) => VersionRun): string {
  const result = run('mise', PINNED_CLANG_QUERY);
  const path = result.stdout.trim();
  if (result.error === undefined && result.status === 0 && path !== '') {
    return path;
  }
  const why =
    errorCode(result.error) === 'ENOENT'
      ? 'mise is not on PATH'
      : `\`mise ${PINNED_CLANG_QUERY.join(' ')}\` failed (${miseError(result)})`;
  throw new BuildError(
    'STA0022',
    `the default C compiler, mise's pinned LLVM clang (${PINNED_CLANG_TOOL}), is unavailable: ${why} ` +
      `— run \`mise install\` in the Stator checkout, or ${CHOOSE}`,
  );
}

/** mise's own reason, e.g. `conda:clang@21.1.8 is not installed`: its first ERROR line, since
 * update notices and hints come on stderr too. */
function miseError(result: VersionRun): string {
  const marker = 'ERROR ';
  const line = (result.stderr ?? '').split('\n').find((text) => text.includes(marker));
  return line === undefined
    ? exitText(result)
    : line.slice(line.indexOf(marker) + marker.length).trim();
}

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
  readonly windows: boolean;
  readonly systemClang: boolean;
  /** The pinned clang's path; called only when the default is the pinned clang. */
  readonly pinnedClang: () => string;
}

export interface ChosenCC {
  readonly choice: CcChoice;
  readonly warning?: string;
}

function defaultCC(host: CcHost, overridden: boolean): string {
  if (overridden) {
    return '/usr/bin/clang';
  }
  return host.windows ? WINDOWS_DEFAULT_CC : host.pinnedClang();
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
    return { choice: { command: defaultCC(host, overridden), source: 'default' } };
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
  readonly stderr?: string;
  readonly error?: unknown;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function exitText(result: VersionRun): string {
  return result.error instanceof Error
    ? result.error.message
    : `exit ${String(result.status ?? 'signal')}`;
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
    throw new BuildError('STA0022', `${named} failed \`--version\` (${exitText(result)}) — ${FIX}`);
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
