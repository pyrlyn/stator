/** Identical function bodies for cold execution and explicit compiler-tier measurements. */
export function compilationCorpus(
  width: number,
  count = 24,
): {
  names: readonly string[];
  source: string;
  turbofan: string;
} {
  const names = Array.from({ length: count }, (_, i) => `t74_kernel_${String(i)}`);
  const definitions = names
    .map((name, index) => {
      const body = Array.from({ length: width }, (_, i) => {
        const delta = ((i + index) % 17) + 1;
        return `x = (x + ${String(delta)}) * 1.0001; if (x > 1000000) x -= 1000000;`;
      }).join('\n');
      return `function ${name}(x) { ${body}\nreturn x; }`;
    })
    .join('\n');
  const answer = `console.log("answer", ${names.map((name, i) => `${name}(${String(i + 1)})`).join(' + ')});\n`;
  const prepare = names
    .map(
      (name) =>
        `%PrepareFunctionForOptimization(${name}); ${name}(1); ${name}(2); %OptimizeFunctionOnNextCall(${name}); ${name}(3);`,
    )
    .join('\n');
  return {
    names,
    source: `${definitions}\n${answer}`,
    turbofan: `${definitions}\n${prepare}\n${answer}`,
  };
}

export interface CompileSample {
  readonly name: string;
  readonly ns: number;
  /** Stator: analysis, lowering, backend, publication. V8: the trace's tier-specific fields. */
  readonly stagesNs: readonly number[];
}

export function parseCompilation(
  output: string,
  tier: 'stator' | 'sparkplug' | 'turbofan',
  names: readonly string[],
): readonly CompileSample[] {
  const samples = new Map<string, CompileSample>();
  for (const line of output.split('\n')) {
    let name: string | undefined;
    let stages: number[];
    if (tier === 'stator') {
      if (!line.startsWith('jit-time: t74_kernel_')) continue;
      const fields = line.split(' ');
      name = fields[1];
      if (fields[2] !== 'compiled' || fields.length !== 7)
        throw new Error(`invalid compilation: ${line}`);
      stages = fields.slice(3).map(Number);
    } else {
      if (!line.startsWith('[completed compiling ') || !line.includes('t74_kernel_')) continue;
      const match = /(?:SharedFunctionInfo|JSFunction) (t74_kernel_[0-9]+)[ >]/.exec(line);
      name = match?.[1];
      const target = tier === 'sparkplug' ? '(target BASELINE)' : '(target TURBOFAN_JS)';
      if (!line.includes(target)) continue;
      const times = / - took ([0-9., ]+) ms\]$/.exec(line)?.[1];
      if (times === undefined) throw new Error(`invalid V8 timing: ${line}`);
      stages = times.split(',').map((v) => Number(v.trim()) * 1e6);
      if (stages.length !== (tier === 'sparkplug' ? 1 : 3))
        throw new Error(`invalid V8 stage count: ${line}`);
    }
    if (
      name === undefined ||
      !names.includes(name) ||
      samples.has(name) ||
      stages.some((n) => !Number.isFinite(n) || n < 0)
    )
      throw new Error(`invalid compilation sample: ${line}`);
    const ns = stages.reduce((sum, n) => sum + n, 0);
    if (ns <= 0) throw new Error(`unresolved compilation duration: ${line}`);
    samples.set(name, { name, ns, stagesNs: stages });
  }
  if (samples.size !== names.length)
    throw new Error(`missing compilation records: ${String(samples.size)}/${String(names.length)}`);
  return [...samples.values()];
}
