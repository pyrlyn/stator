/* Why a spawned run has no exit status (`spawnSync`'s `status` is null): the harness killed it at
 * its timeout, or a signal ended it. Said in words, so a slow run never reads as a crash
 * (`exit null`) and a crash never reads as a slow run. */

/** Why a run has no exit status, so a timeout or a signal never reads as `exit null`. */
export function endedBy(
  r: {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error?: Error;
  },
  timeoutMs: number,
): string {
  if (r.error !== undefined && 'code' in r.error && r.error.code === 'ETIMEDOUT') {
    return `\n[harness] timed out after ${String(timeoutMs / 1000)} s and was killed`;
  }
  if (r.status === null && r.signal !== null) {
    return `\n[harness] killed by ${r.signal}`;
  }
  return '';
}
