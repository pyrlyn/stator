/* What counts as a fixture, for every harness that walks the subset and golden corpora. Each one
 * then applies its own selection (`intl_*`, `--bundler=none`, a mode), but the file-level rules live
 * here so a new fixture shape reaches all of them at once. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compareStrings } from './order.ts';

type Mode = 'ts' | 'js';

/** One first-line `// @name: value` directive of a subset fixture. */
export function directive(source: string, name: string): string | undefined {
  const match = new RegExp(`^//\\s*@${name}:\\s*(.+)$`, 'm').exec(source);
  return match?.[1]?.trim();
}

/** A directory's entry is `main.<mode>`, except a js-mode graph may enter at `main.cjs` or
 * `main.ts`.
 *
 * js mode compiles TypeScript (plan.md §8 step 5): the point of that fixture is a `.ts` file
 * importing an untyped `.js` module, and looking only for `main.js` would skip it. A `.cjs`
 * entry is CommonJS the bundler takes whole under `--node` (plan.md §11d T12.3). */
export function goldenEntry(dir: string, name: string, mode: Mode): string {
  if (name.endsWith(`.${mode}`)) {
    return join(dir, name);
  }
  const folder = join(dir, name);
  const preferred = join(folder, `main.${mode}`);
  if (mode === 'js' && !existsSync(preferred)) {
    for (const other of ['main.cjs', 'main.ts']) {
      const entry = join(folder, other);
      if (existsSync(entry)) {
        return entry;
      }
    }
  }
  return preferred;
}

/** The golden fixture names under `dir`, sorted. A DIRECTORY is a multi-file fixture: its entry is
 * `goldenEntry`, and the other files in it are modules the entry imports. */
export function goldenNames(dir: string, mode: Mode): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(
      (name) =>
        name.endsWith(`.${mode}`) ||
        statSync(join(dir, name), { throwIfNoEntry: false })?.isDirectory(),
    )
    .sort(compareStrings);
}

/** The subset fixture names under `dir`, sorted; `helper_*` and friends are imported, not run. */
export function subsetNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith('subset_'))
    .sort();
}

/** A fixture as a compiler invocation: what to compile and under which flags. */
export interface CorpusFixture {
  readonly key: string;
  readonly path: string;
  readonly mode: Mode;
  readonly node: boolean;
}

/** Every subset and golden fixture, each with the flags its own runner compiles it under. */
export function corpusFixtures(tests: string): CorpusFixture[] {
  const out: CorpusFixture[] = [];
  const subset = join(tests, 'subset');
  for (const name of subsetNames(subset)) {
    const path = join(subset, name);
    const source = readFileSync(path, 'utf8');
    const mode = directive(source, 'mode');
    if (mode !== 'ts' && mode !== 'js') {
      throw new Error(`${name}: missing or invalid "// @mode: ts|js"`);
    }
    out.push({ key: `subset/${name}`, path, mode, node: directive(source, 'node') === 'true' });
  }
  for (const mode of ['ts', 'js'] as const) {
    const dir = join(tests, 'golden', mode);
    for (const name of goldenNames(dir, mode)) {
      out.push({
        key: `golden/${mode}/${name}`,
        path: goldenEntry(dir, name, mode),
        mode,
        node: name.startsWith('node_'),
      });
    }
  }
  return out;
}
