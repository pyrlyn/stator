/** Generated benchmark input shared byte-for-byte by both engines, apart from the host clock. */
export function steadyDriver(
  expected: readonly number[],
  warmupMs: number,
  sampleMs: number,
): string {
  if (expected.length !== 16 || expected.some((n) => !Number.isSafeInteger(n)))
    throw new Error('benchmark needs 16 safe integer answers');
  return `
var expected = ${JSON.stringify(expected)};
function checkedBatch() {
  var checksum = 0;
  for (var seed = 0; seed < 16; seed++) {
    var answer = bench(seed);
    if (answer !== expected[seed]) throw new Error("wrong answer at seed " + seed);
    checksum += answer;
  }
  return checksum;
}
var warmStarted = __benchNow();
var warmBatches = 0;
do { checkedBatch(); warmBatches++; } while (__benchNow() - warmStarted < ${warmupMs});
console.log("warmup", warmBatches, __benchNow() - warmStarted);
console.error("stator-bench: measured");
globalThis.__benchMeasuredStart = __benchNow();
for (var sample = 0; sample < 15; sample++) {
  var start = __benchNow();
  var batches = 0;
  var checksum = 0;
  do { checksum = checkedBatch(); batches++; } while (__benchNow() - start < ${sampleMs});
  var elapsed = __benchNow() - start;
  console.log("sample", sample, elapsed, batches, checksum);
}
console.error("stator-bench: end");
globalThis.__benchMeasuredEnd = __benchNow();
`;
}

/** GC observation is isolated from throughput runs; Node delivers entries after the script. */
export const nodeGcClock = `
const { PerformanceObserver, performance } = require('node:perf_hooks');
globalThis.__benchNow = () => performance.now();
const events = [];
const observer = new PerformanceObserver(list => events.push(...list.getEntries()));
observer.observe({ entryTypes: ['gc'] });
setImmediate(() => setImmediate(() => {
  events.push(...observer.takeRecords());
  observer.disconnect();
  for (const e of events) {
    if (e.startTime >= globalThis.__benchMeasuredStart &&
        e.startTime + e.duration <= globalThis.__benchMeasuredEnd) {
      console.error('v8-gc: ' + JSON.stringify({ durationNs: e.duration * 1e6, kind: e.detail.kind }));
    }
  }
}));
`;

export function measuredV8Gc(
  stderr: string,
): readonly { readonly durationNs: number; readonly kind: number }[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('v8-gc: '))
    .map((line) => {
      const data: unknown = JSON.parse(line.slice('v8-gc: '.length));
      if (
        typeof data !== 'object' ||
        data === null ||
        !('durationNs' in data) ||
        !('kind' in data) ||
        typeof data.durationNs !== 'number' ||
        !Number.isFinite(data.durationNs) ||
        data.durationNs < 0 ||
        typeof data.kind !== 'number' ||
        !Number.isSafeInteger(data.kind)
      )
        throw new Error('invalid V8 GC event');
      return { durationNs: data.durationNs, kind: data.kind };
    });
}

export interface SteadySample {
  readonly ms: number;
  readonly calls: number;
  readonly checksum: number;
}

export function parseSteady(
  stdout: string,
  expectedChecksum: number,
): {
  readonly warmupMs: number;
  readonly warmupBatches: number;
  readonly samples: readonly SteadySample[];
} {
  const lines = stdout.trim().split('\n');
  const warm = lines.shift()?.split(' ');
  const warmupBatches = Number(warm?.[1]);
  const warmupMs = Number(warm?.[2]);
  if (
    warm?.length !== 3 ||
    warm[0] !== 'warmup' ||
    !Number.isSafeInteger(warmupBatches) ||
    warmupBatches < 1 ||
    !Number.isFinite(warmupMs) ||
    warmupMs <= 0 ||
    lines.length !== 15
  )
    throw new Error('invalid warmup or sample count');
  const samples = lines.map((line, i) => {
    const fields = line.split(' ');
    const ms = Number(fields[2]);
    const batches = Number(fields[3]);
    const checksum = Number(fields[4]);
    if (
      fields.length !== 5 ||
      fields[0] !== 'sample' ||
      Number(fields[1]) !== i ||
      !Number.isFinite(ms) ||
      ms <= 0 ||
      !Number.isSafeInteger(batches) ||
      batches < 1 ||
      !Number.isSafeInteger(batches * 16) ||
      checksum !== expectedChecksum
    )
      throw new Error(`invalid sample ${String(i)}: ${line}`);
    return { ms, calls: batches * 16, checksum };
  });
  return { warmupMs, warmupBatches, samples };
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

/** Trace records outside the measured phase include startup/warmup and are deliberately omitted. */
export function measuredGc(
  stderr: string,
): readonly { readonly pauseNs: number; readonly liveBytes: number }[] {
  let measuring = false;
  const pauses: { pauseNs: number; liveBytes: number }[] = [];
  for (const line of stderr.split('\n')) {
    if (line === 'stator-bench: measured') measuring = true;
    else if (line === 'stator-bench: end') measuring = false;
    else if (measuring && line.startsWith('stator-gc: ')) {
      const data: unknown = JSON.parse(line.slice('stator-gc: '.length));
      if (
        typeof data !== 'object' ||
        data === null ||
        !('pauseNs' in data) ||
        !('liveBytes' in data) ||
        typeof data.pauseNs !== 'number' ||
        !Number.isSafeInteger(data.pauseNs) ||
        data.pauseNs < 0 ||
        typeof data.liveBytes !== 'number' ||
        !Number.isSafeInteger(data.liveBytes) ||
        data.liveBytes < 0
      )
        throw new Error('invalid GC trace record');
      pauses.push({ pauseNs: data.pauseNs, liveBytes: data.liveBytes });
    }
  }
  return pauses;
}
