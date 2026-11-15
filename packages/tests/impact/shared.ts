/* What the impact recorder, the selector driver and the mutation check share (plan.md §9 Task
 * 6.17): where things are, how each harness is started, which tests exist now, and the diff
 * against the map's commit. The decision itself is support/impact.ts, which is pure. */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchGoldenName, benchPrograms } from '../support/bench-programs.ts';
import {
  fullSelection,
  isScriptPath,
  mapFallbackReason,
  parseMap,
  parseUnifiedDiff,
  select,
  type FileChange,
  type HarnessName,
  type ImpactMap,
  type Selection,
} from '../support/impact.ts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PRELOAD = join(REPO, 'packages', 'tests', 'impact', 'preload.ts');
export const DEFAULT_MAP = join(REPO, '.cache', 'impact', 'impact-map.json');
export const VITEST = join(REPO, 'node_modules', '.bin', 'vitest');
export const VITEST_CONFIG = 'packages/tests/vitest.config.ts';
export const UNIT_DIR = 'packages/tests/unit';

export const RUNNERS = {
  subset: 'packages/tests/subset/run.ts',
  golden: 'packages/tests/golden/run.ts',
  leak: 'packages/tests/leak/run.ts',
  ffi: 'packages/tests/ffi/run.ts',
  builtins: 'packages/tests/golden/builtins.ts',
  'node-coverage': 'packages/tests/golden/node-coverage.ts',
  asanGate: 'packages/tests/golden/asan-gate.ts',
} as const;

export const PLATFORM = `${process.platform}-${process.arch}`;

/** The ASan stage-3 environment `asan-gate.ts` uses: the sanitized archive, no leak check. */
export const ASAN_ENV = { STATOR_RUNTIME: 'asan', ASAN_OPTIONS: 'detect_leaks=0' } as const;

export function git(args: readonly string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    // A failing probe (`merge-base --is-ancestor` on an unknown commit) is an answer, not noise.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export interface Command {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export function justCommand(recipe: string): Command {
  return {
    label: `just ${recipe}`,
    command: 'just',
    args: ['-f', 'packages/runtime/justfile', '-d', 'packages/runtime', recipe],
  };
}

/** The archives `pnpm run runtime` builds: `libjsrt.a`, then the std package's `libjsrt_std.a`. */
export function archiveCommands(): Command[] {
  return [
    justCommand('runtime'),
    {
      label: 'just std',
      command: 'just',
      args: ['-f', 'packages/std/justfile', '-d', 'packages/std', 'std'],
    },
  ];
}

export function nodeCommand(
  label: string,
  script: string,
  args: readonly string[] = [],
  env?: Readonly<Record<string, string>>,
): Command {
  return {
    label,
    command: process.execPath,
    args: [script, ...args],
    ...(env === undefined ? {} : { env }),
  };
}

/** Golden's fixture list, spelled as its runner keys it (`ts/name.ts`, `js/dir`, `ts/bench/fib.ts`);
 * `intl_*` fixtures only run in the ICU build, which the map does not record. */
function goldenKeys(): string[] {
  const keys: string[] = [];
  for (const mode of ['ts', 'js'] as const) {
    const dir = join(REPO, 'packages', 'tests', 'golden', mode);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('intl_')) continue;
      if (name.endsWith(`.${mode}`) || statSync(join(dir, name)).isDirectory()) {
        keys.push(`${mode}/${name}`);
      }
    }
  }
  for (const program of benchPrograms()) keys.push(`${program.mode}/${benchGoldenName(program)}`);
  return keys;
}

/** The tests that exist in the working tree now, per harness. */
export function currentTests(): Record<HarnessName, string[]> {
  const unit = readdirSync(join(REPO, UNIT_DIR))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `${UNIT_DIR}/${name}`);
  const subset = readdirSync(join(REPO, 'packages', 'tests', 'subset'))
    .filter((name) => name.startsWith('subset_'))
    .sort();
  const golden = goldenKeys();
  return {
    unit,
    subset,
    golden,
    asan: golden,
    runtime: ['runtime'],
    leak: ['leak'],
    ffi: ['ffi'],
    builtins: ['builtins'],
    'node-coverage': ['node-coverage'],
  };
}

const STATUS: Readonly<Record<string, FileChange['status']>> = { A: 'added', D: 'deleted' };

/** The working tree against `commit`: `git diff` (staged and unstaged) plus untracked files. */
export function gatherChanges(commit: string): FileChange[] {
  const statuses = new Map<string, FileChange['status']>();
  const fields = git(['diff', '--no-renames', '--name-status', '-z', commit]).split('\0');
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const status = fields[at] ?? '';
    const path = fields[at + 1];
    if (path !== undefined && path !== '')
      statuses.set(path, STATUS[status[0] ?? ''] ?? 'modified');
  }
  for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (path !== '') statuses.set(path, 'added');
  }
  const hunks = parseUnifiedDiff(
    git(['diff', '--no-renames', '--no-color', '--no-ext-diff', '-U0', commit]),
  );
  return [...statuses].map(([path, status]): FileChange => {
    const base = { path, status, hunks: hunks.get(path) ?? [] };
    if (!isScriptPath(path)) return base;
    const oldText = status === 'added' ? undefined : git(['show', `${commit}:${path}`]);
    const newText = status === 'deleted' ? undefined : readFileSync(join(REPO, path), 'utf8');
    return {
      ...base,
      ...(oldText === undefined ? {} : { oldText }),
      ...(newText === undefined ? {} : { newText }),
    };
  });
}

function commitIsAncestor(commit: string): boolean {
  try {
    git(['merge-base', '--is-ancestor', commit, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export function readMap(path: string): ImpactMap {
  return parseMap(JSON.parse(readFileSync(path, 'utf8')));
}

/** The whole selector: map → trust check → diff → selection, with every fallback spelled out. */
export function computeSelection(mapPath: string): {
  readonly selection: Selection;
  readonly map: ImpactMap | undefined;
} {
  const current = currentTests();
  if (!existsSync(mapPath)) {
    return {
      selection: fullSelection(
        current,
        `no map at ${mapPath} (record one: pnpm run test:impact:record)`,
      ),
      map: undefined,
    };
  }
  let map: ImpactMap;
  try {
    map = readMap(mapPath);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { selection: fullSelection(current, `unreadable map (${why})`), map: undefined };
  }
  const reason = mapFallbackReason(map, {
    node: process.version,
    platform: PLATFORM,
    commitIsAncestor: commitIsAncestor(map.commit),
  });
  if (reason !== undefined) return { selection: fullSelection(current, reason), map };
  let changes: FileChange[];
  try {
    changes = gatherChanges(map.commit);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { selection: fullSelection(current, `cannot diff against the map (${why})`), map };
  }
  return { selection: select({ map, changes, current }), map };
}
