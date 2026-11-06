// `node:perf_hooks` (plan.md §11c T11.6): the `performance` object `tsc` times its phases with
// (`mark`, `measure`, `clearMarks`, `clearMeasures`, `now`), over `std/process.hrtimeNs` and
// `std/time.nowMs`. Gaps, each a subset or N2 limit:
// - `timeOrigin` is the wall clock when this module initialized, in whole milliseconds (Node's
//   has a fraction), and `now()` counts from that point, where Node counts from process start;
// - an unknown mark name throws a plain `SyntaxError` with Node's message, where Node throws a
//   `DOMException` named `SyntaxError` (extending a built-in is not-yet);
// - `mark` and `measure` take a name and mark names only: the options-bag forms, `detail`,
//   `PerformanceObserver`, `timerify`, histograms and `eventLoopUtilization` have not landed.

import { hrtimeNs } from 'std/process';
import { nowMs } from 'std/time';

const originNs = hrtimeNs();
const originMs = nowMs();

/** One timeline entry: a mark (duration 0) or a measure between two points. */
export class PerformanceEntry {
  readonly name: string;
  readonly entryType: string;
  readonly startTime: number;
  readonly duration: number;

  constructor(name: string, entryType: string, startTime: number, duration: number) {
    this.name = name;
    this.entryType = entryType;
    this.startTime = startTime;
    this.duration = duration;
  }
}

/** Milliseconds since `timeOrigin`, with the clock's nanosecond resolution. */
function elapsedMs(): number {
  return (hrtimeNs() - originNs) / 1e6;
}

export class Performance {
  private marks: PerformanceEntry[] = [];
  private measures: PerformanceEntry[] = [];

  get timeOrigin(): number {
    return originMs;
  }

  now(): number {
    return elapsedMs();
  }

  /** Records a mark at the current time; a second mark of the same name is another entry. */
  mark(name: string): PerformanceEntry {
    const entry = new PerformanceEntry(name, 'mark', elapsedMs(), 0);
    this.marks.push(entry);
    return entry;
  }

  /** A measure from `startMark` (else the origin) to `endMark` (else now). A mark name reads
   * the latest mark of that name, as Node does. */
  measure(name: string, startMark?: string, endMark?: string): PerformanceEntry {
    const end = endMark === undefined ? elapsedMs() : this.markTime(endMark);
    const start = startMark === undefined ? 0 : this.markTime(startMark);
    const entry = new PerformanceEntry(name, 'measure', start, end - start);
    this.measures.push(entry);
    return entry;
  }

  clearMarks(name?: string): void {
    this.marks = name === undefined ? [] : this.marks.filter((entry) => entry.name !== name);
  }

  clearMeasures(name?: string): void {
    this.measures = name === undefined ? [] : this.measures.filter((entry) => entry.name !== name);
  }

  /** Every mark and measure, ordered by start time; ties keep the order they were recorded in. */
  getEntries(): PerformanceEntry[] {
    return this.marks.concat(this.measures).sort((a, b) => a.startTime - b.startTime);
  }

  getEntriesByName(name: string, type?: string): PerformanceEntry[] {
    return this.getEntries().filter(
      (entry) => entry.name === name && (type === undefined || entry.entryType === type),
    );
  }

  getEntriesByType(type: string): PerformanceEntry[] {
    return this.getEntries().filter((entry) => entry.entryType === type);
  }

  private markTime(name: string): number {
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const entry = this.marks[i];
      if (entry !== undefined && entry.name === name) return entry.startTime;
    }
    throw new SyntaxError(`The "${name}" performance mark has not been set`);
  }
}

export const performance = new Performance();

/** The default export: Node's module object, of which `tsc` reads `performance`. */
export class PerfHooksModule {
  readonly performance = performance;
}

export default new PerfHooksModule();
