/* The ratchet the differential harnesses share (typediff, zigdiff): write the report, record counts
 * with `--update`, and otherwise fail when any count moved the wrong way against the baseline.
 *
 * A key is judged by the direction it lists under. A key in neither list is informational, so a
 * harness can report totals that may legitimately move either way. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RatchetArgs<K extends string> {
  readonly name: string;
  readonly baselinePath: string;
  readonly reportPath: string;
  readonly counts: Readonly<Record<K, number>>;
  readonly report: unknown;
  /** Keys that may only fall: a difference, a crash. */
  readonly mayOnlyFall: readonly K[];
  /** Keys that may only rise: a match, a stage that has landed. */
  readonly mayOnlyRise?: readonly K[];
}

/** Returns the process exit code. No baseline yet is a pass: there is nothing to regress from. */
export function ratchet<K extends string>(args: RatchetArgs<K>): number {
  const { name, baselinePath, reportPath, counts } = args;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(args.report, undefined, 2));
  console.log(`${name}: report in ${reportPath}`);

  if (process.argv.includes('--update')) {
    writeFileSync(baselinePath, `${JSON.stringify(counts, undefined, 2)}\n`);
    return 0;
  }
  if (!existsSync(baselinePath)) return 0;
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Partial<Record<K, number>>;
  let failed = false;
  for (const key of args.mayOnlyFall) {
    const was = baseline[key] ?? 0;
    if (counts[key] > was) {
      console.error(`${name}: ${key} rose from ${String(was)} to ${String(counts[key])}`);
      failed = true;
    }
  }
  for (const key of args.mayOnlyRise ?? []) {
    const was = baseline[key] ?? 0;
    if (counts[key] < was) {
      console.error(`${name}: ${key} fell from ${String(was)} to ${String(counts[key])}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
