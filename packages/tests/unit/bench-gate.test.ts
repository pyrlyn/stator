import { describe, expect, it } from 'vitest';
import { geomean, regressionGate, type RegressionPolicy } from '../bench/gate.ts';
import {
  benchGoldenName,
  benchKey,
  benchPrograms,
  engineAgnostic,
} from '../support/bench-programs.ts';

const POLICY: RegressionPolicy = { geomeanPercent: 20, programPercent: 50, programFloorMs: 5 };

/* Ten steady programs, so one program's change moves the geomean by its tenth root and the
 * per-program rule is what a test exercises. */
const STEADY: Record<string, number> = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`steady${String(i)}.ts`, 100]),
);

function timed(entries: Record<string, number>): { program: string; runtimeMsBest: number }[] {
  return Object.entries(entries).map(([program, runtimeMsBest]) => ({ program, runtimeMsBest }));
}

describe('benchmark regression gate', () => {
  it('passes an unchanged recording', () => {
    const run = timed({ 'fib.ts': 100, 'nbody.ts': 40 });
    expect(regressionGate(run, run, POLICY)).toEqual({ failures: [], added: [] });
  });

  it('fails a geomean regression past its threshold', () => {
    const report = regressionGate(timed({ a: 100, b: 100 }), timed({ a: 130, b: 130 }), POLICY);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/^benchmark regression 30\.0% exceeds 20%/);
  });

  it('fails one program that regressed while the geomean stayed inside its threshold', () => {
    const before = timed({ a: 100, b: 100, c: 100, d: 100, e: 100, f: 100, g: 100, h: 100 });
    const after = Object.fromEntries(before.map((m) => [m.program, m.runtimeMsBest]));
    after['c'] = 200;
    const report = regressionGate(before, timed(after), POLICY);
    expect(geomean(timed(after)) / geomean(before)).toBeLessThan(1.2);
    expect(report.failures).toEqual(['c: 100.00 → 200.00 ms (+100.0%) exceeds 50%']);
  });

  it('ignores a millisecond-scale program whose growth stays under the floor', () => {
    const report = regressionGate(
      timed({ ...STEADY, 'startup.ts': 3 }),
      timed({ ...STEADY, 'startup.ts': 7 }),
      POLICY,
    );
    expect(report.failures).toEqual([]);
  });

  it('fails a small program once its growth reaches the floor', () => {
    const report = regressionGate(timed({ ...STEADY, a: 4 }), timed({ ...STEADY, a: 9 }), POLICY);
    expect(report.failures).toEqual(['a: 4.00 → 9.00 ms (+125.0%) exceeds 50%']);
  });

  it('reports a new program and keeps it out of the geomean comparison', () => {
    const report = regressionGate(timed({ a: 10 }), timed({ a: 10, slow: 1000 }), POLICY);
    expect(report).toEqual({ failures: [], added: ['slow'] });
  });

  it('does not count a removed program as a speed-up or a regression', () => {
    const report = regressionGate(timed({ a: 10, gone: 1 }), timed({ a: 11 }), POLICY);
    expect(report.failures).toEqual([]);
  });

  it('does not fail on an empty or zero-time previous recording', () => {
    expect(regressionGate([], timed({ a: 10 }), POLICY).failures).toEqual([]);
    expect(regressionGate(timed({ a: 0 }), timed({ a: 10 }), POLICY).failures).toEqual([]);
  });
});

describe('benchmark program list', () => {
  const programs = benchPrograms();

  it('holds both modes, never a declaration file, with unique result keys', () => {
    expect(programs.some((p) => p.mode === 'ts')).toBe(true);
    expect(programs.some((p) => p.mode === 'js')).toBe(true);
    expect(programs.filter((p) => p.name.endsWith('.d.ts'))).toEqual([]);
    const keys = programs.map(benchKey);
    expect(new Set(keys).size).toBe(keys.length);
    const golden = programs.map((p) => `${p.mode}/${benchGoldenName(p)}`);
    expect(new Set(golden).size).toBe(golden.length);
  });

  it('keeps the keys results were recorded under before the js set joined', () => {
    const fib = programs.find((p) => p.mode === 'ts' && p.name === 'fib.ts');
    expect(fib === undefined ? undefined : benchKey(fib)).toBe('fib.ts');
  });

  it('keeps Stator-only programs away from other engines', () => {
    const agnostic = programs.filter(engineAgnostic).map((p) => p.name);
    expect(agnostic).not.toContain('ffi-sqrt.ts');
    expect(agnostic).not.toContain('startup.ts');
    expect(agnostic).toContain('fib.ts');
  });
});
