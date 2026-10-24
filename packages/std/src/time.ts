// `std/time` — the wall clock and a sync sleep (docs/STD.md §5).

import { jsrtStdTimeNowMs, jsrtStdTimeSleepMs } from './native/time.js';
import { __stdFailure } from './internal/error.ts';

/** Milliseconds since the Unix epoch, an integer — the clock `Date.now()` reads. */
export function nowMs(): number {
  return jsrtStdTimeNowMs();
}

/** Blocks the thread for `ms` milliseconds (fractions truncated). NaN, negative or over 2^31-1
 * is EINVAL. This does not drain Promise reactions; other OS threads may continue. */
export function sleepMs(ms: number): void {
  if (jsrtStdTimeSleepMs(ms) !== 0) {
    throw __stdFailure('std/time.sleepMs', `${ms}`);
  }
}
