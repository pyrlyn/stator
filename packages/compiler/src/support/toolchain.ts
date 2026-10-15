/** macOS SDK fallback for a stale bundled linker (conda ld64 vs a newer Xcode SDK).
 *
 * The pinned conda clang 21.1.8 ships ld64-956.6, which predates the `.tbd` format Xcode 26
 * writes: the SDK's `libSystem.tbd` names dotted arch variants (`arm64e.x1-macos`) the old
 * parser rejects as `malformed file ... unknown architecture`, so EVERY link against the
 * default SDK fails — including a trivial `int main`. Compiling is unaffected (only the link
 * reads `.tbd` files), and the sanitizer path is unaffected (it already links with
 * `/usr/bin/clang` on Darwin). Linux and Windows never enter here.
 *
 * The repair is a retry, not a switch: the first link runs exactly as before (zero cost on
 * the green path), and only a failure carrying the stale-linker signature retries once with
 * `-isysroot` pointed at the newest Command Line Tools SDK whose `libSystem.tbd` the old
 * parser can still read. An explicit `CC` is the caller's toolchain choice and is never
 * second-guessed. Nothing here is recorded in `link-flags.txt`: the sysroot is host state,
 * like the ASan `CC` fallback, not part of the archive's link contract.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where `xcode-select --install` puts versioned SDKs (`MacOSX26.5.sdk`, …). */
export const CLT_SDK_ROOT = '/Library/Developer/CommandLineTools/SDKs';

/** `MacOSX<major>[.<minor>].sdk` as numbers, or `undefined` when `name` is not that shape.
 * A missing minor is -1, so `MacOSX26.sdk` is older than `MacOSX26.0.sdk`. A name that does
 * not match is `undefined` rather than version 0.0: the old destructuring default ranked
 * `notes.txt` and `MacOSXbad.sdk` equal to `MacOSX0.0.sdk`, so a garbage directory could
 * sort as the newest fallback. */
function versionedSdkRank(name: string): readonly [number, number] | undefined {
  const match = /^MacOSX(\d+)(?:\.(\d+))?\.sdk$/.exec(name);
  if (match === null) {
    return undefined;
  }
  const majorText = match[1];
  if (majorText === undefined) {
    return undefined;
  }
  // Both groups are `\d+` when present, so parseInt cannot return NaN. `Number.isNaN` is
  // outside the subset (STA1214) and is not needed to reject a non-match: that is `null`.
  const major = Number.parseInt(majorText, 10);
  const minorText = match[2];
  const minor = minorText === undefined ? -1 : Number.parseInt(minorText, 10);
  return [major, minor];
}

/** Version order for `MacOSX<major>[.<minor>].sdk` names. Lexicographic order lies:
 * `"MacOSX26.sdk"` sorts after `"MacOSX26.5.sdk"` (`'s' > '5'`), while 26.0 predates 26.5 —
 * and picking the older SDK is how a working fallback lost to a broken one. Numeric
 * components compare numerically; a missing minor is older than any present one. A name
 * that is not a versioned SDK ranks below every versioned one, and two such names compare
 * lexicographically, so malformed input stays visible in the order. */
export function compareSdkNames(first: string, second: string): number {
  const a = versionedSdkRank(first);
  const b = versionedSdkRank(second);
  if (a === undefined || b === undefined) {
    if (a === undefined && b === undefined) {
      if (first < second) return -1;
      if (first > second) return 1;
      return 0;
    }
    return a === undefined ? -1 : 1;
  }
  const majorDelta = a[0] - b[0];
  return majorDelta !== 0 ? majorDelta : a[1] - b[1];
}

/** The `.tbd` whose format decides whether the bundled linker can use an SDK. */
export function tbdPathOf(sdkPath: string): string {
  return join(sdkPath, 'usr', 'lib', 'libSystem.tbd');
}

/** Dotted `arm64e` sub-variants (`arm64e.x1`, …) — the notation ld64-956 chokes on
 * (`unknown architecture`). Plain `arm64e` (no dot) parses fine and must NOT match. */
const NEW_ARCH_TOKEN = /arm64e\.[a-z0-9]+/;

/** Whether this stderr is the stale-linker signature: the linker names a `.tbd` system
 * library as malformed or with an unknown architecture. Kept narrow on purpose — any
 * other link failure (missing `-lfoo`, a real undefined symbol) must surface unchanged. */
export function isStaleLdSystemLibFailure(stderr: string): boolean {
  return (
    stderr.includes('.tbd') &&
    (stderr.includes('malformed file') || stderr.includes('unknown architecture'))
  );
}

/** One SDK candidate: its directory name and its `libSystem.tbd` text, if readable. */
export interface SdkCandidate {
  readonly name: string;
  readonly tbdText: string | undefined;
}

/** Pure selection: newest versioned `MacOSX<major>[.<minor>].sdk` under `sdkRoot` (bare
 * `MacOSX.sdk`, and any name that is not that shape, is never a fallback) whose `.tbd`
 * carries no new-arch token. `undefined` when no candidate qualifies — the caller then
 * reports the original failure with a hint. */
export function pickFallbackSdk(
  sdkRoot: string,
  candidates: readonly SdkCandidate[],
): string | undefined {
  const usable = candidates
    .filter(
      (candidate) =>
        versionedSdkRank(candidate.name) !== undefined &&
        candidate.tbdText !== undefined &&
        !NEW_ARCH_TOKEN.test(candidate.tbdText),
    )
    .map((candidate) => candidate.name)
    .sort(compareSdkNames);
  const newest = usable[usable.length - 1];
  return newest === undefined ? undefined : join(sdkRoot, newest);
}

/** Filesystem half: read the CLT SDK directory into candidates and pick. `undefined` on
 * any filesystem surprise (no CLT directory, unreadable entries) — never a throw, since
 * this runs on a link-failure path that already has an error to report. */
export function findFallbackSdk(sdkRoot: string = CLT_SDK_ROOT): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(sdkRoot);
  } catch {
    return undefined;
  }
  const candidates: SdkCandidate[] = [];
  for (const name of entries) {
    if (!name.startsWith('MacOSX') || !name.endsWith('.sdk')) {
      continue;
    }
    const tbd = tbdPathOf(join(sdkRoot, name));
    let tbdText: string | undefined;
    try {
      tbdText = existsSync(tbd) ? readFileSync(tbd, 'utf8') : undefined;
    } catch {
      tbdText = undefined;
    }
    candidates.push({ name, tbdText });
  }
  return pickFallbackSdk(sdkRoot, candidates);
}

/** When the caller links with the default toolchain on Darwin (never an explicit `CC`,
 * never the sanitized path that already uses the system compiler): the amended link
 * args retrying once under the newest readable CLT SDK, or `undefined` when no retry
 * applies. Every test-side consumer link (export-stubs, the FFI C-consumer) shares this
 * with the CLI's own link, so the workaround is stated once. */
export function staleLdRetryArgs(
  args: readonly string[],
  stderr: string,
  opts: { darwin: boolean; defaultCc: boolean; sanitized: boolean },
): { readonly args: readonly string[]; readonly sysroot: string } | undefined {
  if (!opts.darwin || opts.sanitized || !opts.defaultCc || !isStaleLdSystemLibFailure(stderr)) {
    return undefined;
  }
  const fallback = findFallbackSdk();
  return fallback === undefined
    ? undefined
    : { args: [...args, '-isysroot', fallback], sysroot: fallback };
}

/** The actionable hint appended to the link diagnostic when the stale-linker signature
 * matched: what was retried (or why no retry was possible) and the two manual escapes. */
export function staleLdHint(retriedSysroot: string | undefined): string {
  const tried =
    retriedSysroot === undefined
      ? 'no older Command Line Tools SDK was found to retry with'
      : `retrying with -isysroot ${retriedSysroot} failed too`;
  return (
    `the system SDK's .tbd files use a format this linker's ld cannot parse ` +
    `(stale bundled ld vs a newer Xcode; ${tried}) — install the CLT ` +
    `(\`xcode-select --install\`) or link with the system compiler (\`CC=/usr/bin/clang\`)`
  );
}
