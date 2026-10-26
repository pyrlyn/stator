/* Run a command under `/usr/bin/time` and read its peak RSS (bench/record.ts, bench/memory/run.ts).
 *
 * The report is parsed line by line without backtracking regexes: the lines around it are the
 * measured program's own stderr, whose size and content are not ours to bound.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

const TIME = '/usr/bin/time';

export interface TimedRun {
  readonly status: number | null;
  readonly stdout: string;
  /** The command's own stderr, with `time`'s report removed. */
  readonly stderr: string;
  /** Peak RSS as `time` printed it (bytes on macOS, KiB on Linux); 0 when unavailable. */
  readonly maxRssRaw: number;
  readonly maxRssBytes: number;
  /** hrtime, not `time`'s `real` (10 ms resolution); includes the ~1 ms wrapper. */
  readonly ms: number;
}

export interface TimedRunOptions {
  readonly cwd?: string;
  readonly timeout?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export function timedRun(
  command: string,
  args: readonly string[],
  options: TimedRunOptions = {},
): TimedRun {
  const darwin = platform() === 'darwin';
  const timed = existsSync(TIME);
  const started = process.hrtime.bigint();
  const result = spawnSync(
    timed ? TIME : command,
    timed ? [...(darwin ? ['-l'] : ['-f', '%M']), command, ...args] : [...args],
    {
      encoding: 'utf8',
      cwd: options.cwd,
      timeout: options.timeout ?? 120_000,
      env: options.env ?? process.env,
      maxBuffer: 64 << 20,
    },
  );
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  let lines = (result.stderr ?? '').split('\n');
  let raw = 0;
  if (timed && darwin) {
    const peak = lines.find((l) => l.includes('maximum resident set size'));
    raw = Number.parseInt(peak?.trim() ?? '', 10) || 0;
    lines = lines.filter((l) => !isDarwinReportLine(l));
  } else if (timed) {
    // `-f %M` prints the number alone on the last non-empty line.
    let last = lines.length - 1;
    while (last >= 0 && (lines[last] ?? '').trim() === '') last -= 1;
    const value = lines[last]?.trim() ?? '';
    if (value !== '' && Number.isSafeInteger(Number(value))) {
      raw = Number(value);
      lines = lines.slice(0, last);
    }
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: lines.join('\n').trimEnd(),
    maxRssRaw: raw,
    maxRssBytes: darwin ? raw : raw * 1024,
    ms,
  };
}

/** `time -l` prints "0.30 real  0.00 user  0.00 sys", then "  1179648  maximum resident set size" rows. */
function isDarwinReportLine(line: string): boolean {
  const t = line.trim();
  if (t.endsWith(' sys') && t.includes(' real ')) return true;
  const gap = t.indexOf(' ');
  return gap > 0 && /^\d+$/.test(t.slice(0, gap)) && /^[a-z ]+$/.test(t.slice(gap));
}
