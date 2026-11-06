// `std/os` — the machine and the user's account (docs/STD.md §5). Every answer is the one the
// pinned Node's `node:os` gives on the same machine, so `packages/node` can build `node:os` on
// these without re-deriving them.

import { jsrtStdResult } from './native/core.js';
import {
  jsrtStdOsArch,
  jsrtStdOsCpuCount,
  jsrtStdOsHomedir,
  jsrtStdOsHostname,
  jsrtStdOsPlatform,
  jsrtStdOsRelease,
  jsrtStdOsTmpdir,
  jsrtStdOsTotalMemory,
  jsrtStdOsUname,
} from './native/os.js';
import { __stdFailure } from './internal/error.ts';

/** The line terminator text files use here: `'\n'` on every POSIX platform. */
export const eol: string = '\n';

/** The answer a string backing parked, or its failure thrown as `std/os.<name>(): <CODE>`. */
function __stdOsText(status: number, name: string): string {
  if (status !== 0) {
    throw __stdFailure(`std/os.${name}`, '');
  }
  return jsrtStdResult();
}

/** The OS, spelled as Node's `process.platform` spells it (`'darwin'`, `'linux'`, …). */
export function platform(): string {
  return jsrtStdOsPlatform();
}

/** The CPU architecture, spelled as Node's `process.arch` spells it (`'arm64'`, `'x64'`, …). */
export function arch(): string {
  return jsrtStdOsArch();
}

/** The kernel release from `uname(2)` (Darwin's version on macOS, not the marketing one). */
export function release(): string {
  return __stdOsText(jsrtStdOsRelease(), 'release');
}

/** The kernel's name from `uname(2)` (`'Darwin'`, `'Linux'`, …). */
export function kernelName(): string {
  return __stdOsText(jsrtStdOsUname(0), 'kernelName');
}

/** The kernel's build string from `uname(2)`'s version field. */
export function kernelVersion(): string {
  return __stdOsText(jsrtStdOsUname(2), 'kernelVersion');
}

/** The hardware name from `uname(2)` (`'arm64'` on macOS, `'aarch64'`/`'x86_64'` on Linux),
 * which is not `arch()`'s spelling. */
export function machine(): string {
  return __stdOsText(jsrtStdOsUname(3), 'machine');
}

export function hostname(): string {
  return __stdOsText(jsrtStdOsHostname(), 'hostname');
}

/** `$HOME` whenever it is set (even empty), else the password database's home directory. */
export function homedir(): string {
  return __stdOsText(jsrtStdOsHomedir(), 'homedir');
}

/** The first non-empty of `$TMPDIR`, `$TMP`, `$TEMP`, else `/tmp`, without a trailing `/`. */
export function tmpdir(): string {
  return __stdOsText(jsrtStdOsTmpdir(), 'tmpdir');
}

/** How many CPUs this process may run on (Node's `os.availableParallelism()`); at least 1. */
export function cpuCount(): number {
  return jsrtStdOsCpuCount();
}

/** Physical memory in bytes. */
export function totalMemory(): number {
  const bytes = jsrtStdOsTotalMemory();
  if (bytes < 0) {
    throw __stdFailure('std/os.totalMemory', '');
  }
  return bytes;
}
