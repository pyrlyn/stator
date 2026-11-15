/* The benchmark regression gate (plan.md §9 Task 6.3 step 7, plan/T75): a pure decision over two
 * recordings of the same host, so it can be tested without timing anything. */

export interface TimedProgram {
  readonly program: string;
  readonly runtimeMsBest: number;
}

export interface RegressionPolicy {
  /** The geomean over the programs both recordings share may grow by at most this much. */
  readonly geomeanPercent: number;
  /** One program may grow by at most this much... */
  readonly programPercent: number;
  /** ...unless it grew by less than this many milliseconds: below it, the spread of a
   * millisecond-scale program is process start-up jitter, not the program. */
  readonly programFloorMs: number;
}

/** The geomean gate is Task 6.3's. The per-program pair sits about twice above the widest
 * same-commit spread of five recordings on darwin-arm64 (plan-notes 414): 39.9% for a program
 * past the floor, 5.0 ms for one below it. */
export const REGRESSION_POLICY: RegressionPolicy = {
  geomeanPercent: 20,
  programPercent: 75,
  programFloorMs: 10,
};

export function geomean(measurements: readonly TimedProgram[]): number {
  const values = measurements
    .map((measurement) => measurement.runtimeMsBest)
    .filter((value) => value > 0);
  return values.length === 0
    ? 0
    : Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

function growth(before: number, after: number): number {
  return before === 0 ? 0 : ((after - before) / before) * 100;
}

export interface GateReport {
  /** Why the recording fails; empty when it passes. */
  readonly failures: readonly string[];
  /** Programs with no previous result to compare against: reported, never failed. */
  readonly added: readonly string[];
}

/** Compares `current` with the `previous` recording of the same host. The geomean is taken over
 * the programs both share: a program added or removed changes the mean without anything getting
 * slower, and comparing means over different sets would call that a regression. */
export function regressionGate(
  previous: readonly TimedProgram[],
  current: readonly TimedProgram[],
  policy: RegressionPolicy = REGRESSION_POLICY,
): GateReport {
  const before = new Map(previous.map((measurement) => [measurement.program, measurement]));
  const shared: { readonly old: TimedProgram; readonly now: TimedProgram }[] = [];
  const added: string[] = [];
  for (const now of current) {
    const old = before.get(now.program);
    if (old === undefined) added.push(now.program);
    else shared.push({ old, now });
  }
  const failures: string[] = [];
  const meanGrowth = growth(
    geomean(shared.map((pair) => pair.old)),
    geomean(shared.map((pair) => pair.now)),
  );
  if (meanGrowth > policy.geomeanPercent)
    failures.push(
      `benchmark regression ${meanGrowth.toFixed(1)}% exceeds ${String(policy.geomeanPercent)}% (geomean of ${String(shared.length)} programs)`,
    );
  for (const { old, now } of shared) {
    const percent = growth(old.runtimeMsBest, now.runtimeMsBest);
    const ms = now.runtimeMsBest - old.runtimeMsBest;
    if (percent > policy.programPercent && ms >= policy.programFloorMs)
      failures.push(
        `${now.program}: ${old.runtimeMsBest.toFixed(2)} → ${now.runtimeMsBest.toFixed(2)} ms (+${percent.toFixed(1)}%) exceeds ${String(policy.programPercent)}%`,
      );
  }
  return { failures, added };
}
