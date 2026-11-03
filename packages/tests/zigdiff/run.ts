// The regression gate for the Zig port: every ported stage against the TypeScript compiler, its
// oracle, over the subset and golden corpora. A stage whose binary or subcommand is missing is
// `not ported`, never a pass. Counts ratchet against baseline.json; --update records them.
//
// The oracle's answers are cached under .cache/zigdiff/oracle, one directory per tree stamp: a fresh
// TypeScript program per fixture is minutes of CPU, and the Zig side changes far more often.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildError, build, withDiagnosticCapture } from '../../compiler/src/cli/build.ts';
import { explainFile, type Explanation } from '../../compiler/src/cli/explain.ts';
import { corpusFixtures, type CorpusFixture } from '../support/corpus.ts';
import { pool, runProcess, shardSlice } from '../support/parallel.ts';
import { ratchet } from '../support/ratchet.ts';
import { dumpFixture, dumpFoldProbe } from './oracle.ts';
import { RULE_PROGRAMS } from './rules.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tests = resolve(here, '..');
const repo = resolve(here, '../../..');
const baselinePath = join(here, 'baseline.json');
const cacheRoot = join(repo, '.cache/zigdiff');
const reportPath = join(cacheRoot, 'report.json');
const binary =
  process.env['STATOR_ZIG'] ?? join(repo, 'packages/compiler-zig/zig-out/bin/statorc-zig');
const firstDifferences = 50;

/** No source behind it: the oracle builds this HIR by hand (folds.ts), so only the stages that read
 * a dump see it. */
const FOLD_PROBE: CorpusFixture = { key: 'synthetic/folds', path: '', mode: 'ts', node: false };

/** Written where the oracle's cache lives, so they leave the source tree as they found it. */
function ruleFixtures(): CorpusFixture[] {
  const dir = join(cacheRoot, 'rules');
  mkdirSync(dir, { recursive: true });
  return Object.entries(RULE_PROGRAMS).map(([name, source]) => {
    const path = join(dir, name);
    writeFileSync(path, source);
    return { key: `zigdiff/${name}`, path, mode: 'ts', node: false };
  });
}

const STAGES = ['gate', 'lower', 'verifier', 'passes', 'codegen'] as const;
type Stage = (typeof STAGES)[number];

/** The subcommand each stage is reached through. */
const SUBCOMMANDS: Readonly<Record<Stage, string>> = {
  gate: 'explain',
  lower: 'lower',
  verifier: 'verify',
  passes: 'passes',
  codegen: 'emit-c',
};

const COUNT_NAMES = ['ported', 'cases', 'same', 'different', 'refused', 'crashed'] as const;
type CountName = (typeof COUNT_NAMES)[number];
type CountKey = `${Stage}.${CountName}`;

type Outcome =
  | { readonly kind: 'same' }
  | { readonly kind: 'different' | 'refused' | 'crashed'; readonly detail: string };

interface Difference {
  readonly fixture: string;
  readonly detail: string;
}

/** A fixture's directory name: stable across runs, and free of the separators in its key. */
function slug(fixture: CorpusFixture): string {
  return fixture.key.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Everything an oracle answer depends on, by size and mtime: hashing contents would cost a read of
 * thousands of files to save a rerun that a touched file only rarely causes. */
function treeStamp(): string {
  const roots = [
    'packages/compiler/src',
    'packages/std/src',
    'packages/node/src',
    'packages/tests/subset',
    'packages/tests/golden/ts',
    'packages/tests/golden/js',
  ];
  const hash = createHash('sha256');
  for (const name of ['oracle.ts', 'folds.ts', 'rules.ts', 'dump-hir.ts']) {
    hash.update(readFileSync(join(here, name)));
  }
  for (const root of roots) {
    const entries = readdirSync(join(repo, root), { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    for (const file of files) {
      const { size, mtimeMs } = statSync(file);
      hash.update(`${file}\0${String(size)}\0${String(mtimeMs)}\0`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/** The oracle's whole answer for one fixture, written to its own directory. A throw is recorded,
 * not raised: a fixture the oracle cannot compile is data about that fixture, and the worker has
 * hundreds more to get through. */
async function oracleOne(fixture: CorpusFixture, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  try {
    if (fixture.key === FOLD_PROBE.key) {
      dumpFoldProbe(dir);
      return;
    }
    const explanation = await explainFile(fixture.path, fixture.mode, undefined, fixture.node);
    writeFileSync(join(dir, 'explain.json'), JSON.stringify(explanation));
    if (explanation.verdict !== 'static' && explanation.verdict !== 'dynamic') return;
    const out = join(dir, 'out.c');
    const { result } = await withDiagnosticCapture(() =>
      build({
        entry: fixture.path,
        out,
        mode: fixture.mode,
        emitCOnly: true,
        keepC: false,
        node: fixture.node,
      }),
    );
    if (result !== 0) throw new Error(`--emit=c exited ${String(result)}`);
    await dumpFixture(fixture, dir);
  } catch (error) {
    const message =
      error instanceof BuildError || error instanceof Error ? error.message : String(error);
    writeFileSync(join(dir, 'threw.txt'), message);
  } finally {
    writeFileSync(join(dir, 'done'), '');
  }
}

/** Worker: `--oracle=<file>`, one chunk of the fixtures still missing from the cache. */
async function oracleWorker(listPath: string): Promise<number> {
  const work = JSON.parse(readFileSync(listPath, 'utf8')) as {
    readonly dir: string;
    readonly fixtures: readonly CorpusFixture[];
  };
  for (const fixture of work.fixtures) {
    await oracleOne(fixture, join(work.dir, slug(fixture)));
  }
  return 0;
}

async function fillOracle(fixtures: readonly CorpusFixture[], dir: string): Promise<void> {
  const missing = fixtures.filter((f) => !existsSync(join(dir, slug(f), 'done')));
  if (missing.length === 0) return;
  console.log(`zigdiff: oracle over ${String(missing.length)} fixtures`);
  mkdirSync(dir, { recursive: true });
  const requested = Number.parseInt(process.env['STATOR_TEST_JOBS'] ?? '', 10);
  const workers = Number.isFinite(requested) && requested > 0 ? requested : 8;
  const chunks = Array.from({ length: workers }, (_unused, i) =>
    shardSlice(missing, { index: i + 1, total: workers }).map(({ item }) => item),
  ).filter((chunk) => chunk.length > 0);
  await pool(chunks, async (chunk, slot) => {
    const list = join(dir, `chunk-${String(slot)}.json`);
    writeFileSync(list, JSON.stringify({ dir, fixtures: chunk }));
    const { status, stderr } = await runProcess(process.execPath, [
      fileURLToPath(import.meta.url),
      `--oracle=${list}`,
    ]);
    if (status !== 0) throw new Error(`zigdiff: oracle worker exited ${String(status)}\n${stderr}`);
  });
}

/** Where two texts first part, with enough of each side to read the difference in a report. */
function firstDifference(theirs: string, ours: string): string {
  let at = 0;
  while (at < theirs.length && theirs[at] === ours[at]) at += 1;
  const window = (text: string): string =>
    JSON.stringify(text.slice(Math.max(0, at - 60), at + 120));
  return `at byte ${String(at)}: oracle ${window(theirs)} zig ${window(ours)}`;
}

function compareText(theirs: string, ours: string): Outcome {
  return theirs === ours
    ? { kind: 'same' }
    : { kind: 'different', detail: firstDifference(theirs, ours) };
}

/** Exit 0 means the subcommand answered; a usable non-zero exit is the caller's to name. */
async function zig(args: readonly string[], allowed: readonly number[] = [0]) {
  const { status, stdout, stderr } = await runProcess(binary, args, { timeoutMs: 60_000 });
  if (status === null || !allowed.includes(status)) {
    return { ok: false as const, detail: `exit ${String(status)}: ${stderr.slice(0, 400)}` };
  }
  return { ok: true as const, stdout };
}

/** What a verdict claims: the verdict, its code, and every diagnostic's code and line. Messages
 * stay out, because tests reference codes and message wording is free to change. */
function verdictKey(explanation: Explanation): string {
  return JSON.stringify({
    verdict: explanation.verdict,
    code: explanation.code,
    diagnostics: explanation.diagnostics?.map((d) => [d.code, d.line]),
  });
}

async function gateCases(fixture: CorpusFixture, dir: string): Promise<Outcome[]> {
  const path = join(dir, 'explain.json');
  if (!existsSync(path)) return [];
  const theirs = JSON.parse(readFileSync(path, 'utf8')) as Explanation;
  const run = await zig([
    'explain',
    `--mode=${fixture.mode}`,
    ...(fixture.node ? ['--node'] : []),
    '--json',
    fixture.path,
  ]);
  if (!run.ok) return [{ kind: 'crashed', detail: run.detail }];
  let ours: Explanation;
  try {
    ours = JSON.parse(run.stdout) as Explanation;
  } catch {
    return [{ kind: 'crashed', detail: `not JSON: ${run.stdout.slice(0, 200)}` }];
  }
  return [compareText(verdictKey(theirs), verdictKey(ours))];
}

/** The fixtures the oracle lowered, and only those. A refusal is its own count: the Zig compiler
 * stopped with a diagnostic where the oracle went on, which is neither a wrong HIR nor a crash. */
async function lowerCases(fixture: CorpusFixture, dir: string): Promise<Outcome[]> {
  const lowered = join(dir, 'lowered.json');
  if (!existsSync(lowered)) return [];
  const { status, stdout, stderr } = await runProcess(
    binary,
    ['lower', `--mode=${fixture.mode}`, ...(fixture.node ? ['--node'] : []), fixture.path],
    { timeoutMs: 60_000 },
  );
  if (status === 1) return [{ kind: 'refused', detail: stderr.slice(0, 400) }];
  if (status !== 0) {
    return [{ kind: 'crashed', detail: `exit ${String(status)}: ${stderr.slice(0, 400)}` }];
  }
  return [compareText(readFileSync(lowered, 'utf8'), stdout)];
}

/** The lowered dump, the optimized dump, and the mutants the oracle's verifier rejects. Without
 * them a verifier that accepted everything would agree on every dump: the corpus compiles, so every
 * clean dump is clean by construction. */
async function verifierCases(dir: string): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const name of ['lowered', 'optimized', 'mutant', 'targeted']) {
    const dump = join(dir, `${name}.json`);
    if (!existsSync(dump)) continue;
    const run = await zig(['verify', dump], [0, 1]);
    if (!run.ok) {
      out.push({ kind: 'crashed', detail: `${name}: ${run.detail}` });
      continue;
    }
    out.push(compareText(readFileSync(join(dir, `${name}.verify.txt`), 'utf8'), run.stdout));
  }
  return out;
}

async function passesCases(dir: string): Promise<Outcome[]> {
  const lowered = join(dir, 'lowered.json');
  if (!existsSync(lowered)) return [];
  const run = await zig(['passes', lowered]);
  if (!run.ok) return [{ kind: 'crashed', detail: run.detail }];
  return [compareText(readFileSync(join(dir, 'optimized.json'), 'utf8'), run.stdout)];
}

async function codegenCases(dir: string): Promise<Outcome[]> {
  const expected = join(dir, 'out.c');
  if (!existsSync(expected)) return [];
  const run = await zig(['emit-c', join(dir, 'optimized.json')]);
  if (!run.ok) return [{ kind: 'crashed', detail: run.detail }];
  return [compareText(readFileSync(expected, 'utf8'), run.stdout)];
}

const CASES: Readonly<Record<Stage, (fixture: CorpusFixture, dir: string) => Promise<Outcome[]>>> =
  {
    gate: gateCases,
    lower: lowerCases,
    verifier: (_fixture, dir) => verifierCases(dir),
    passes: (_fixture, dir) => passesCases(dir),
    codegen: (_fixture, dir) => codegenCases(dir),
  };

async function runStage(
  stage: Stage,
  fixtures: readonly CorpusFixture[],
  oracle: string,
  ported: boolean,
): Promise<{ counts: Record<CountName, number>; differences: Difference[] }> {
  const counts = {
    ported: ported ? 1 : 0,
    cases: 0,
    same: 0,
    different: 0,
    refused: 0,
    crashed: 0,
  };
  const differences: Difference[] = [];
  if (!ported) return { counts, differences };
  const results = await pool(fixtures, (fixture) =>
    CASES[stage](fixture, join(oracle, slug(fixture))),
  );
  fixtures.forEach((fixture, i) => {
    for (const outcome of results[i] ?? []) {
      counts.cases += 1;
      counts[outcome.kind] += 1;
      if (outcome.kind !== 'same') {
        differences.push({ fixture: fixture.key, detail: `${outcome.kind}: ${outcome.detail}` });
      }
    }
  });
  return { counts, differences };
}

/** A stage is ported when the binary answers its subcommand. Asked with no arguments every command
 * complains, so the answer is told apart from the driver's `STA0003`, a stable code where usage text
 * is not. Silence counts as not ported: a stub that exits 0 on everything must not read as a pass. */
async function portedStages(): Promise<ReadonlySet<Stage>> {
  if (!existsSync(binary)) {
    console.log(`zigdiff: no binary at ${binary}; set STATOR_ZIG or build packages/compiler-zig`);
    return new Set();
  }
  const ported = await Promise.all(
    STAGES.map(async (stage) => {
      const { stdout, stderr } = await runProcess(binary, [SUBCOMMANDS[stage]]);
      const answer = stdout + stderr;
      return answer.trim() !== '' && !answer.includes('STA0003') ? [stage] : [];
    }),
  );
  return new Set(ported.flat());
}

function checked<K extends string>(keys: readonly K[]): K[] {
  return [...keys];
}

async function main(): Promise<number> {
  const worker = process.argv.find((a) => a.startsWith('--oracle='));
  if (worker !== undefined) return oracleWorker(worker.slice('--oracle='.length));

  const filter = process.argv.find((a) => a.startsWith('--filter='))?.slice('--filter='.length);
  const fixtures = [...corpusFixtures(tests), ...ruleFixtures(), FOLD_PROBE].filter(
    (f) => filter === undefined || f.key.includes(filter),
  );
  const oracle = join(cacheRoot, 'oracle', treeStamp());
  await fillOracle(fixtures, oracle);

  const ported = await portedStages();
  const counts = {} as Record<CountKey, number>;
  const report: Partial<Record<Stage, { total: number; first: Difference[] }>> = {};
  for (const stage of STAGES) {
    const result = await runStage(stage, fixtures, oracle, ported.has(stage));
    for (const name of COUNT_NAMES) counts[`${stage}.${name}`] = result.counts[name];
    report[stage] = {
      total: result.differences.length,
      first: result.differences.slice(0, firstDifferences),
    };
    const { cases, same, different, refused, crashed } = result.counts;
    console.log(
      ported.has(stage)
        ? `zigdiff: ${stage}: ${String(same)}/${String(cases)} same, ${String(different)} different, ${String(refused)} refused, ${String(crashed)} crashed`
        : `zigdiff: ${stage}: not ported`,
    );
  }
  const threw = fixtures.filter((f) => existsSync(join(oracle, slug(f), 'threw.txt')));
  console.log(
    `zigdiff: ${String(fixtures.length)} fixtures, oracle threw on ${String(threw.length)}`,
  );

  // A filtered run measures a slice, so it can neither update nor fail the corpus-wide baseline.
  if (filter !== undefined) return 0;
  return ratchet({
    name: 'zigdiff',
    baselinePath,
    reportPath,
    counts,
    report: { counts, oracleThrew: threw.map((f) => f.key), stages: report },
    mayOnlyFall: checked(
      STAGES.flatMap((s) => [`${s}.different`, `${s}.refused`, `${s}.crashed`] as const),
    ),
    mayOnlyRise: checked(STAGES.flatMap((s) => [`${s}.ported`, `${s}.same`] as const)),
  });
}

process.exitCode = await main();
