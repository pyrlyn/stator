// `std/env` — the process environment and working directory (docs/STD.md §5).
//
// The environment is libc's (`getenv`/`setenv`/`unsetenv` behind packages/std/zig/env.zig), so a
// change here is the change every C caller in the process sees. A missing variable is not an
// error: `get` answers `undefined`, and `has` asks without reading.

import { jsrtStdResult, type CString } from './native/core.js';
import {
  jsrtStdEnvCount,
  jsrtStdEnvCwd,
  jsrtStdEnvGet,
  jsrtStdEnvHas,
  jsrtStdEnvName,
  jsrtStdEnvSet,
  jsrtStdEnvUnset,
} from './native/env.js';
import { __stdFailure, __stdQuote } from './internal/error.ts';
import { __stdStrings } from './internal/strings.ts';

/** Whether `name` is set (to any value, the empty string included). */
export function has(name: string): boolean {
  return jsrtStdEnvHas(name as CString) === 1;
}

/** The value of `name`, or `undefined` when it is not set. */
export function get(name: string): string | undefined {
  if (!has(name)) {
    return undefined;
  }
  return jsrtStdEnvGet(name as CString);
}

/** Sets `name` to `value`, replacing any value. EINVAL for an empty name or one containing `=`;
 * the error names the variable, never the value, which may be a secret. */
export function set(name: string, value: string): void {
  if (jsrtStdEnvSet(name as CString, value as CString) !== 0) {
    throw __stdFailure('std/env.set', __stdQuote(name));
  }
}

/** Removes `name`; removing an unset name succeeds. EINVAL for an empty name or one with `=`. */
export function unset(name: string): void {
  if (jsrtStdEnvUnset(name as CString) !== 0) {
    throw __stdFailure('std/env.unset', __stdQuote(name));
  }
}

/** The absolute path of the working directory. */
export function cwd(): string {
  if (jsrtStdEnvCwd() !== 0) {
    throw __stdFailure('std/env.cwd', '');
  }
  return jsrtStdResult();
}

/** Every variable's name, in the environment's own order (Node's `Object.keys(process.env)`).
 * The names only: a value may be a secret, and nothing here prints one. */
export function names(): string[] {
  return __stdStrings(jsrtStdEnvCount(), (i: number): string => {
    if (jsrtStdEnvName(i) !== 0) {
      throw __stdFailure('std/env.names', '');
    }
    return jsrtStdResult();
  });
}
