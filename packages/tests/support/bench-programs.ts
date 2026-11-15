/* The one list of benchmark programs (plan/T75). `bench:record` times all of them, the golden
 * runner checks every one against Node, and `engine:bench`, `bench:memory` and `bench:profile`
 * take the engine-agnostic ones. A second hand-written list is how a new program ends up timed
 * by one harness and never checked by another. */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `ts`-mode programs; a sibling `.d.ts` is an include, not a program. */
export const BENCH_TS_DIR = join(TESTS, 'bench', 'programs');
/** `js`-mode programs, shared with `engine:bench`, which owns them. */
export const BENCH_JS_DIR = join(TESTS, 'engine', 'bench');

export interface BenchProgram {
  /** The file name; unique within a mode, and what results and the regression gate key on. */
  readonly name: string;
  readonly path: string;
  readonly mode: 'ts' | 'js';
}

/* ffi-sqrt calls a Stator extern, so another engine runs a different program (its Math.sqrt
 * fallback); startup is empty, a floor for a native binary that an engine's own start-up
 * already measures. */
const STATOR_ONLY: ReadonlySet<string> = new Set(['ffi-sqrt.ts', 'startup.ts']);

function listed(dir: string, mode: 'ts' | 'js'): BenchProgram[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(`.${mode}`) && !name.endsWith('.d.ts'))
    .sort()
    .map((name) => ({ name, path: join(dir, name), mode }));
}

/** Every benchmark program: the `ts`-mode set, then the `js`-mode set, each sorted by name. */
export function benchPrograms(): BenchProgram[] {
  return [...listed(BENCH_TS_DIR, 'ts'), ...listed(BENCH_JS_DIR, 'js')];
}

/** The programs any JavaScript engine runs unchanged, as written. */
export function engineAgnostic(program: BenchProgram): boolean {
  return !STATOR_ONLY.has(program.name);
}

/** The golden runner's name for a program; its key is `<mode>/bench/<name>`. */
export function benchGoldenName(program: BenchProgram): string {
  return `bench/${program.name}`;
}

/** The key a program's result goes under: the bare name for the `ts` set, which keeps the keys
 * results recorded before the `js` set joined, and `js/<name>` for the rest. */
export function benchKey(program: BenchProgram): string {
  return program.mode === 'ts' ? program.name : `js/${program.name}`;
}
