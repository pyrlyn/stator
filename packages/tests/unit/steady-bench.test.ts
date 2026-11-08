import { describe, expect, it } from 'vitest';
import { measuredGc, measuredV8Gc, parseSteady, steadyDriver } from '../engine/steady-protocol.ts';

const valid = [
  'warmup 2 1000',
  ...Array.from({ length: 15 }, (_, i) => `sample ${String(i)} 100 2 120`),
].join('\n');

describe('warmed benchmark evidence', () => {
  it('retains V8 GC kinds and rejects invalid event durations', () => {
    expect(measuredV8Gc('v8-gc: {"durationNs":12.5,"kind":1}')).toEqual([
      { durationNs: 12.5, kind: 1 },
    ]);
    expect(() => measuredV8Gc('v8-gc: {"durationNs":-1,"kind":1}')).toThrow();
    expect(() => measuredV8Gc('v8-gc: {"durationNs":null,"kind":1}')).toThrow();
  });
  it('rejects missing, malformed, zero-duration and wrong-answer measurements', () => {
    expect(parseSteady(valid, 120).samples[0]).toEqual({ ms: 100, calls: 32, checksum: 120 });
    for (const bad of [
      valid.replace('sample 0', 'sample 1'),
      valid.replace('100 2 120', '0 2 120'),
      valid.replace('100 2 120', 'NaN 2 120'),
      valid.replace('100 2 120', '100 2 121'),
      valid.replace('100 2 120', '100 0 120'),
      valid.split('\n').slice(1).join('\n'),
    ]) {
      expect(() => parseSteady(bad, 120)).toThrow();
    }
  });

  it('does not turn a failed oracle into a usable driver', () => {
    expect(() => steadyDriver([], 1000, 100)).toThrow();
    expect(() =>
      steadyDriver(
        Array.from({ length: 16 }, () => Number.NaN),
        1000,
        100,
      ),
    ).toThrow();
  });

  it('counts only measured GC pauses, preserving zero when no GC occurred', () => {
    const event = 'stator-gc: {"pauseNs":1234,"liveBytes":5678}';
    expect(
      measuredGc(`${event}\nstator-bench: measured\n${event}\nstator-bench: end\n${event}`),
    ).toEqual([{ pauseNs: 1234, liveBytes: 5678 }]);
    expect(measuredGc('stator-bench: measured\nstator-bench: end')).toEqual([]);
    expect(() =>
      measuredGc('stator-bench: measured\nstator-gc: {"pauseNs":-1,"liveBytes":0}'),
    ).toThrow();
  });
});
