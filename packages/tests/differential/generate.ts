/* Deterministic, type-directed differential-fuzzer input generator (plan.md §9 Task 6.2). */

export type DifferentialMode = 'ts' | 'js';

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type ValueType = 'number' | 'string' | 'boolean';

/** Xorshift32 is deliberately the only entropy source in this directory. */
export class XorShift32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  int(maxExclusive: number): number {
    return this.next() % maxExclusive;
  }
}

const NUMBER_EDGES = [
  -2147483648,
  -2147483647,
  -1,
  0,
  1,
  2147483646,
  2147483647,
  9007199254740991,
  0.1,
  1.5,
  Number.MIN_VALUE,
  Number.MAX_VALUE,
] as const;

const STRINGS = ['', 'a', 'hello', '\ud800', '\ud83d\udc4d', 'left\tright', '𝄞'];

// The values whose IDENTITY the spec treats differently from their equality, which is what makes
// them Map/Set key edges (SameValueZero folds -0 into 0 and makes NaN equal to itself) and print
// edges (`-0` keeps its sign, `NaN`/`Infinity` are not decimal). Kept OUT of NUMBER_EDGES because
// arithmetic over them mostly yields NaN, which would drown the float-formatting region rather
// than add to it (plan.md §9 Task 6.2; the weighted regions are recorded in done.md → Phase 6).
const IDENTITY_EDGES = ['NaN', 'Infinity', '-Infinity', '-0', '0'] as const;

// Operands from disjoint types, so `==` has to run the coercion table rather than compare directly.
// js mode only: ts mode refuses a cross-type `==` (STA0012, TS 2367), which is the whole point of
// the subset_loose_equals_cross_type pair. `Object.is` is deliberately absent -- still STA1214.
const COERCION_OPERANDS = ['""', '"1"', '"0"', '0', '1', 'null', 'undefined', 'false', 'true'] as const;

function pick(values: readonly string[], random: XorShift32): string {
  return values[random.int(values.length)] ?? '0';
}

function numberLiteral(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value);
}

function chooseType(random: XorShift32): ValueType {
  const pick = random.int(10);
  return pick < 6 ? 'number' : pick < 8 ? 'string' : 'boolean';
}

function expression(type: ValueType, random: XorShift32, depth: number): string {
  if (depth === 0) {
    if (type === 'number') {
      return numberLiteral(NUMBER_EDGES[random.int(NUMBER_EDGES.length)] ?? 0);
    }
    if (type === 'string') {
      return JSON.stringify(STRINGS[random.int(STRINGS.length)] ?? '');
    }
    return random.int(2) === 0 ? 'false' : 'true';
  }

  if (type === 'number') {
    const choice = random.int(6);
    if (choice === 0) {
      return `(${expression('number', random, depth - 1)} + ${expression('number', random, depth - 1)})`;
    }
    if (choice === 1) {
      return `(${expression('number', random, depth - 1)} * ${expression('number', random, depth - 1)})`;
    }
    if (choice === 2) {
      return `Math.trunc(${expression('number', random, depth - 1)})`;
    }
    if (choice === 3) {
      return `Math.abs(${expression('number', random, depth - 1)})`;
    }
    if (choice === 4) {
      return `(${expression('number', random, depth - 1)} % ${expression('number', random, 0)})`;
    }
    return numberLiteral(NUMBER_EDGES[random.int(NUMBER_EDGES.length)] ?? 0);
  }
  if (type === 'string') {
    if (random.int(3) === 0) {
      return `(${expression('string', random, depth - 1)} + ${expression('string', random, depth - 1)})`;
    }
    return JSON.stringify(STRINGS[random.int(STRINGS.length)] ?? '');
  }
  if (random.int(2) === 0) {
    return `(Math.trunc(${expression('number', random, depth - 1)}) === Math.trunc(${expression('number', random, depth - 1)}))`;
  }
  return random.int(2) === 0 ? 'false' : 'true';
}

function typedProgram(random: XorShift32): string {
  const lines: string[] = [];
  const first = chooseType(random);
  const second = chooseType(random);
  lines.push(`const a: ${first} = ${expression(first, random, 2)};`);
  lines.push(`let b: ${second} = ${expression(second, random, 2)};`);
  lines.push(`b = ${expression(second, random, 1)};`);
  lines.push(`const values: number[] = [${expression('number', random, 1)}, ${expression('number', random, 1)}];`);
  lines.push('let total: number = 0;');
  lines.push('for (const value of values) { total += value; }');
  lines.push('console.log(a);');
  lines.push('console.log(b);');
  lines.push('console.log(total);');
  lines.push('console.log(values.length);');
  // String indexing across surrogate pairs and the identity/print edges: two of the five regions
  // step 4 names, and the two the golden fixtures cannot enumerate by hand. `codePointAt` stays in
  // the js half -- it is `number | undefined`, which ts mode would have to narrow first.
  lines.push(`const text: string = ${JSON.stringify(STRINGS[random.int(STRINGS.length)] ?? '')};`);
  lines.push('console.log(text.length);');
  lines.push(`console.log(text.charCodeAt(${String(random.int(4))}));`);
  lines.push(`const edge: number = ${pick(IDENTITY_EDGES, random)};`);
  lines.push('console.log(edge);');
  lines.push('console.log(1 / edge);');
  return `${lines.join('\n')}\n`;
}

function dynamicProgram(random: XorShift32): string {
  const number = expression('number', random, 2);
  const string = expression('string', random, 1);
  const key = random.int(2) === 0 ? '"value"' : '"other"';
  const keyA = pick(IDENTITY_EDGES, random);
  const keyB = pick(IDENTITY_EDGES, random);
  const left = pick(COERCION_OPERANDS, random);
  const right = pick(COERCION_OPERANDS, random);
  return [
    `var n = ${number};`,
    `const text = ${string};`,
    'const object = {};',
    `object[${key}] = n;`,
    'let total = 0;',
    'for (var i = 0; i < 2; i += 1) { total += i; }',
    'console.log(object.value ?? object.other);',
    'console.log(text);',
    'console.log(n == total);',
    // Map/Set key identity is SameValueZero, which agrees with neither `===` (NaN) nor `==` (-0),
    // so it is only reachable through the containers themselves.
    'const map = new Map();',
    `map.set(${keyA}, "a");`,
    `map.set(${keyB}, "b");`,
    'console.log(map.size);',
    `console.log(map.get(${keyA}));`,
    'const set = new Set();',
    `set.add(${keyA});`,
    `set.add(${keyB});`,
    'console.log(set.size);',
    `console.log(${left} == ${right});`,
    'console.log(text.length);',
    `console.log(text.codePointAt(${String(random.int(4))}));`,
    '',
  ].join('\n');
}

// --- Extern-call arm (docs/FFI.md sections 1-2, 4) ---
//
// What it generates: `declare`d libm bindings CALLED as direct C calls — `sqrt` (plain),
// `fmod2` (plain, two arguments), `fmodChecked` (`@statorError nonzero`) and `logChecked`
// (`@statorError negative`) — over fuzzed doubles. The declarations live in the extern_libm
// golden's `libm.d.ts`, pulled in with a `/// <reference path>` whose absolute path is
// computed from this file, so the generated program stays one file (all the differential
// `execute` writes) on any checkout. The coupling is read-only and fails loudly: a moved
// file is a TS error, which `run.ts` reports as a generator bug, never a divergence.
//
// Oracle strategy (the differential runner has no `--import` shim hook — that is the golden
// runner's mechanism, `tests/golden/run.ts` — so the mirror lives IN the program): each call
// sits in its own try/catch. Under Stator the declaration resolves and the call is a direct
// C call; under Node the ambient declaration erases and the call throws ReferenceError. The
// catch dispatches on `instanceof ReferenceError` (a working instanceof in both modes,
// docs/SUBSET.md): the ReferenceError branch re-spells the call in JS (`Math.sqrt`, `%`,
// `Math.log` — bit-exact mirrors of libm on IEEE doubles, the same claim `node_shim.ts`
// makes) INCLUDING the convention check and its exact message, while the `Error` branch
// prints Stator's own `caught: <message>`. One try per call, so a firing convention cannot
// skip the later calls on either side. Both directions stay differentially sensitive: a
// missing throw prints a value where the mirror prints `caught`, a spurious throw prints
// `caught` where the mirror prints a value, and a reworded message fails the byte compare.
//
// Scope and exclusions, each with its reason:
// - Plain + nonzero + negative conventions only: those are the ones Node can mirror.
// - `void` returns: excluded — no linkable void extern exists (`extSeed` names a fake
//   symbol decision tests never link), and a void call prints nothing, so there is no
//   oracle signal either way.
// - `errno` (`sqrtErrno`): excluded — C errno has no JS oracle; even the golden covers
//   only its success path.
// - The `null` convention (`getEnvChecked`) and the CString calls (`numOf`, `getEnv`):
//   excluded — they need strings and the environment, the differential runner pins neither
//   (no `PINNED_ENV`), and the string-codec edges belong to the `print_ffi_strings` corpus.
// - Branded pointers: excluded — STA1217 (no lowering until Phase 7 step 6).
// - Malformed externs (STA1114-21 shapes): NEVER generated — decision fixtures own those
//   rows, and `run.ts` throws on any non-STA4xxx build failure, so a refusal here would be
//   a generator bug by construction.
//
// Minimizer: no new rule needed (`minimize.ts` untouched). Statement-dropping cannot drop
// the `/// <reference>` line — without it the ts build fails (predicate false) and the js
// Stator side falls into the same mirror path as Node (no divergence, predicate false) —
// and the token rewrites never rename a call callee (the identifier-char guard) while any
// other breakage fails the predicate.
const EXTERN_EVERY = 8;
const EXTERN_STREAM = 0x9e3779b9;
const EXTERN_LIBM_DTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'golden',
  'ts',
  'extern_libm',
  'libm.d.ts',
).replace(/\\/g, '/');

// Operand doubles for the extern arm: edge literals for exactness plus the identity/print
// spellings, which double as convention-comparison edges (NaN never fires `negative` and
// always fires `nonzero`; -0 fires neither) on both sides of the oracle.
function externDouble(random: XorShift32): string {
  if (random.int(2) === 0) {
    return numberLiteral(NUMBER_EDGES[random.int(NUMBER_EDGES.length)] ?? 0);
  }
  return pick(IDENTITY_EDGES, random);
}

function externProgram(random: XorShift32, mode: DifferentialMode): string {
  const typed = mode === 'ts';
  // `const x: number` in ts mode, `var x` in js mode — the try/catch bodies are identical.
  const num = (name: string, value: string): string =>
    typed ? `const ${name}: number = ${value};` : `var ${name} = ${value};`;
  const lines = [`/// <reference path="${EXTERN_LIBM_DTS}" />`];
  const x0 = externDouble(random);
  lines.push(num('x0', x0));
  lines.push('try {');
  lines.push('  console.log(sqrt(x0));');
  lines.push('} catch (e) {');
  lines.push('  if (e instanceof ReferenceError) {');
  lines.push('    console.log(Math.sqrt(x0));');
  lines.push('  } else if (e instanceof Error) {');
  lines.push('    console.log("caught: " + e.message);');
  lines.push('  }');
  lines.push('}');
  const a0 = externDouble(random);
  const b0 = externDouble(random);
  lines.push(num('a0', a0));
  lines.push(num('b0', b0));
  lines.push('try {');
  lines.push('  console.log(fmod2(a0, b0));');
  lines.push('} catch (e) {');
  lines.push('  if (e instanceof ReferenceError) {');
  lines.push('    console.log(a0 % b0);');
  lines.push('  } else if (e instanceof Error) {');
  lines.push('    console.log("caught: " + e.message);');
  lines.push('  }');
  lines.push('}');
  const a1 = externDouble(random);
  const b1 = externDouble(random);
  lines.push(num('a1', a1));
  lines.push(num('b1', b1));
  lines.push('try {');
  lines.push('  console.log(fmodChecked(a1, b1));');
  lines.push('} catch (e) {');
  lines.push('  if (e instanceof ReferenceError) {');
  lines.push(typed ? '    const r1: number = a1 % b1;' : '    var r1 = a1 % b1;');
  lines.push('    if (r1 !== 0) {');
  lines.push('      console.log("caught: extern call \'fmodChecked\' failed: nonzero return");');
  lines.push('    } else {');
  lines.push('      console.log(r1);');
  lines.push('    }');
  lines.push('  } else if (e instanceof Error) {');
  lines.push('    console.log("caught: " + e.message);');
  lines.push('  }');
  lines.push('}');
  const x1 = externDouble(random);
  lines.push(num('x1', x1));
  lines.push('try {');
  lines.push('  console.log(logChecked(x1));');
  lines.push('} catch (e) {');
  lines.push('  if (e instanceof ReferenceError) {');
  lines.push(typed ? '    const l1: number = Math.log(x1);' : '    var l1 = Math.log(x1);');
  lines.push('    if (l1 < 0) {');
  lines.push('      console.log("caught: extern call \'logChecked\' failed: negative return");');
  lines.push('    } else {');
  lines.push('      console.log(l1);');
  lines.push('    }');
  lines.push('  } else if (e instanceof Error) {');
  lines.push('    console.log("caught: " + e.message);');
  lines.push('  }');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export function generateProgram(seed: number, mode: DifferentialMode): string {
  // One seed in eight exercises the extern-call arm below instead of the base program. The
  // divisor is a pure function of the seed (never a stream draw), so every other seed's program
  // is byte-identical to before this arm landed, and seed 42 stays a base program for the
  // phase6 unit test (42 % 8 === 2). Weight rationale: the fuzzable extern surface is four
  // declarations times one fixed call shape each, against the much larger arithmetic, string,
  // container and identity regions above — 1/8 keeps those dominant while hitting libm every
  // eight seeds. The arm runs its own xorshift stream (domain-separated by xor) so its operand
  // draws do not mirror the base stream's for the same seed.
  if (seed % EXTERN_EVERY === 0) {
    return externProgram(new XorShift32(seed ^ EXTERN_STREAM), mode);
  }
  const random = new XorShift32(seed);
  return mode === 'ts' ? typedProgram(random) : dynamicProgram(random);
}

function parseSeed(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error('--seed=N is required and N must be a non-negative integer');
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed)) {
    throw new Error('--seed=N must be a safe integer');
  }
  return seed;
}

function main(): void {
  const seedArg = process.argv.find((arg) => arg.startsWith('--seed='))?.slice('--seed='.length);
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) ?? 'ts';
  const seed = parseSeed(seedArg);
  if (modeArg !== 'ts' && modeArg !== 'js') {
    throw new Error('--mode must be ts or js');
  }
  process.stdout.write(`seed: ${String(seed)}\n${generateProgram(seed, modeArg)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
