import { describe, expect, it } from 'vitest';
import { compilationCorpus, parseCompilation } from '../engine/compile-protocol.ts';

describe('compilation measurements', () => {
  const names = ['t74_kernel_0'];
  it('requires a successful record for every named function', () => {
    const valid = 'jit-time: t74_kernel_0 compiled 10 20 30 40';
    expect(parseCompilation(valid, 'stator', names)[0]?.ns).toBe(100);
    for (const bad of [
      '',
      valid + '\n' + valid,
      valid.replace('compiled', 'rejected'),
      valid.replace('10', 'NaN'),
      valid.replace('10', '-1'),
      valid.replace(' 40', ''),
    ]) {
      expect(() => parseCompilation(bad, 'stator', names)).toThrow();
    }
  });
  it('distinguishes V8 tiers and preserves rounded stage timings', () => {
    const baseline =
      '[completed compiling 0x1 <SharedFunctionInfo t74_kernel_0> (target BASELINE) - took 0.003 ms]';
    const optimized =
      '[completed compiling 0x1 <JSFunction t74_kernel_0 (sfi = 0x2)> (target TURBOFAN_JS) - took 0.010, 0.120, 0.004 ms]';
    expect(parseCompilation(baseline, 'sparkplug', names)[0]?.ns).toBe(3000);
    expect(parseCompilation(optimized, 'turbofan', names)[0]?.ns).toBe(134000);
    expect(() => parseCompilation(baseline, 'turbofan', names)).toThrow();
    expect(() => parseCompilation(optimized.replace('0.120, ', ''), 'turbofan', names)).toThrow();
    expect(() =>
      parseCompilation(baseline.replace('0.003', '0.000'), 'sparkplug', names),
    ).toThrow();
  });
  it('keeps V8 preparation outside the common function definitions', () => {
    const corpus = compilationCorpus(8, 2);
    const definitions = corpus.source.split('console.log')[0] ?? '';
    expect(corpus.turbofan.startsWith(definitions)).toBe(true);
    expect(corpus.source).not.toContain('%Prepare');
    expect(corpus.names).toEqual(['t74_kernel_0', 't74_kernel_1']);
  });
});
