/* Decision-test runner (plan.md §4 Task 1.4).
 *
 * Each fixture is tests/subset/subset_<feature>_<mode>.ts|.js with first-line directives:
 *   // @mode: ts|js
 *   // @verdict: static | dynamic | error | not-yet
 *   // @code: STA1101          (required for error/not-yet)
 *   // @expected-fail: true    (pre-implementation; reported, never hidden)
 *   // @node: true             (explain with `--node`, the Node platform; docs/MODES.md §6)
 *
 * Verdicts come from in-process `explainFile` (the same function the `stator explain`
 * CLI prints as `--json`). Fixtures marked expected-fail are not
 * executed — they are counted, so the corpus can land before the compiler can pass it.
 *
 * Usage: node packages/tests/subset/run.ts [--filter <substring> | --filter=<substring>]
 *          [--only=<file>] [--shard=N/M] [--shards=N]
 *
 * `--only=<file>` runs just the fixtures named in the file, one per line — the selection
 * `pnpm run test:impact` hands over (plan.md §9 Task 6.17). It composes with `--filter`.
 *
 * `--shard=N/M` runs one round-robin slice of the (filtered) fixtures; `--shards=N` fans out to
 * N worker processes of this same runner and merges their per-item records back by index, so the
 * merged report is byte-identical to the serial one. Both compose with `--filter`, which applies
 * first. In-process `explainFile` is single-threaded CPU, so `--shards` is what scales a local
 * iteration with cores; full runs choose up to four workers automatically.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explainFile } from '../../compiler/src/cli/explain.ts';
import type { InProcessRecorder } from '../impact/recorder.ts';
import { directive, subsetNames } from '../support/corpus.ts';
import { impactRecorder } from '../support/impact-hook.ts';
import {
  fanOutWorkers,
  mergeShardFiles,
  parseShardArgs,
  pool,
  readOnlyList,
  runnerShardCount,
  shardSlice,
  workerBaseArgs,
  writeShardFile,
  type Shard,
} from '../support/parallel.ts';

type Verdict = 'static' | 'dynamic' | 'error' | 'not-yet';

interface Directives {
  mode: 'ts' | 'js';
  verdict: Verdict;
  code?: string;
  expectedFail: boolean;
  node: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const VERDICTS: readonly string[] = ['static', 'dynamic', 'error', 'not-yet'];

/* Codes allocated by docs/DIAGNOSTICS.md, which plan §4 Task 1.3 makes the sole allocator.
 * Everything below the "Retired codes" heading is deliberately excluded: a retired code appears
 * in that file precisely so it is never used again. This check runs on expected-fail fixtures
 * too — they are the ones nothing else looks at, so an invented code would otherwise sit
 * unnoticed until the phase that implements the feature. */
function allocatedCodes(): ReadonlySet<string> {
  const table = readFileSync(join(REPO, '..', 'docs', 'DIAGNOSTICS.md'), 'utf8');
  const live = table.split('## Retired codes')[0] ?? table;
  return new Set(live.match(/^\| (STA\d{4}) \|/gm)?.map((row) => row.slice(2, 9)) ?? []);
}

function parseDirectives(file: string, source: string): Directives {
  const mode = directive(source, 'mode');
  const verdict = directive(source, 'verdict');
  const code = directive(source, 'code');
  if (mode !== 'ts' && mode !== 'js') {
    throw new Error(`${file}: missing or invalid "// @mode: ts|js"`);
  }
  if (verdict === undefined || !VERDICTS.includes(verdict)) {
    throw new Error(`${file}: missing or invalid "// @verdict: ${VERDICTS.join(' | ')}"`);
  }
  if ((verdict === 'error' || verdict === 'not-yet') && code === undefined) {
    throw new Error(`${file}: "// @code: STAxxxx" is required for verdict "${verdict}"`);
  }
  const parsed: Directives = {
    mode,
    verdict: verdict as Verdict,
    expectedFail: directive(source, 'expected-fail') === 'true',
    node: directive(source, 'node') === 'true',
  };
  return code === undefined ? parsed : { ...parsed, code };
}

async function explain(
  file: string,
  mode: 'ts' | 'js',
  node: boolean,
): Promise<{ verdict: string; code?: string }> {
  // In-process (plan.md §9 Task 6.6): one `explainFile` call instead of a fresh
  // `node …/cli/main.ts explain --json` spawn per fixture. The `explain` CLI always
  // exits 0 with the verdict as the answer — a refusal is a result, not a throw — and
  // `explainFile` preserves that: rejections come back as a verdict, and only a missing
  // entry throws (which the caller reports per fixture, as the spawn failure was).
  const result = await explainFile(file, mode, undefined, node);
  return result.code === undefined
    ? { verdict: result.verdict }
    : { verdict: result.verdict, code: result.code };
}

/* `--filter` narrows the run to fixtures whose filename contains the substring (developer
 * iteration speed: debug one fixture without running 400+). Both spellings mirror the CLI's
 * dual `--mode` form in packages/compiler/src/cli/main.ts. Filtering happens before pooling,
 * and the summary line reports the filtered totals honestly. A filter that matches nothing is
 * a result, never an error. Flag parsing itself lives in support/parallel.ts (`parseShardArgs`),
 * shared with the golden runner so the two reports cannot drift apart. */

// One outcome per fixture, INDEXED BY FIXTURE: the pool finishes out of order, and a failure list
// whose order depended on that would differ between two runs of an unchanged tree. Hoisted to
// module scope so the shard-merge decode below rebuilds exactly this type.
type Outcome =
  | { readonly kind: 'passed' }
  | { readonly kind: 'expected-fail' }
  | { readonly kind: 'failed'; readonly message: string };

function encodeOutcome(outcome: Outcome): unknown {
  return outcome.kind === 'failed'
    ? { kind: outcome.kind, message: outcome.message }
    : { kind: outcome.kind };
}

function decodeOutcome(value: unknown): Outcome {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new Error('shard record value is not an outcome');
  }
  const kind: unknown = value.kind;
  if (kind === 'passed') return { kind: 'passed' };
  if (kind === 'expected-fail') return { kind: 'expected-fail' };
  if (kind === 'failed') {
    if (!('message' in value) || typeof value.message !== 'string') {
      throw new Error('shard record failure has no message');
    }
    return { kind: 'failed', message: value.message };
  }
  throw new Error(`shard record has unknown kind ${String(kind)}`);
}

/* With an impact recorder the pool is one wide (the recorder insists), so the take after each
 * fixture holds exactly what that fixture ran. */
async function evaluate(
  names: readonly string[],
  allocated: ReadonlySet<string>,
  impact: InProcessRecorder | undefined,
): Promise<Outcome[]> {
  return pool(names, async (name): Promise<Outcome> => {
    const outcome = await evaluateOne(name, allocated);
    await impact?.take(name);
    return outcome;
  });
}

async function evaluateOne(name: string, allocated: ReadonlySet<string>): Promise<Outcome> {
  const path = join(HERE, name);
  const want = parseDirectives(name, readFileSync(path, 'utf8'));
  if (want.code !== undefined && !allocated.has(want.code)) {
    return {
      kind: 'failed',
      message: `${name}: @code ${want.code} is not allocated in docs/DIAGNOSTICS.md`,
    };
  }
  // Expected-fail fixtures are still evaluated. A marker that outlives the work it was waiting
  // for is worse than no marker: it silently exempts a fixture that would now hold the line.
  try {
    const got = await explain(path, want.mode, want.node);
    const matches =
      got.verdict === want.verdict && (want.code === undefined || got.code === want.code);
    if (want.expectedFail) {
      return matches
        ? { kind: 'failed', message: `${name}: now passes — remove the @expected-fail marker` }
        : { kind: 'expected-fail' };
    }
    if (matches) return { kind: 'passed' };
    return {
      kind: 'failed',
      message:
        got.verdict === want.verdict
          ? `${name}: code ${got.code ?? '(none)'}, want ${want.code ?? '(none)'}`
          : `${name}: verdict ${got.verdict}, want ${want.verdict}`,
    };
  } catch (error) {
    if (want.expectedFail) return { kind: 'expected-fail' };
    return {
      kind: 'failed',
      message: `${name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/* The one report, shared verbatim by the serial run, a direct `--shard` slice, and the merged
 * `--shards` run — a second copy here would be a second definition of "the subset result". A
 * `shard` names the slice honestly; `undefined` is the whole (filtered) list, byte-identical to
 * the pre-sharding report. */
function printReport(
  allCount: number,
  filteredCount: number,
  names: readonly string[],
  outcomes: readonly Outcome[],
  shard: Shard | undefined,
): void {
  const passed = outcomes.filter((outcome) => outcome.kind === 'passed').length;
  const expectedFail = outcomes.filter((outcome) => outcome.kind === 'expected-fail').length;
  const failures = outcomes
    .filter((outcome) => outcome.kind === 'failed')
    .map((outcome) => outcome.message);

  for (const failure of failures) {
    process.stderr.write(`FAIL ${failure}\n`);
  }
  // No flags: `663 fixtures` / `5 fixtures (filtered from 663)` — exactly the pre-sharding text.
  // A direct `--shard` appends its selector so a slice never poses as the whole run. The
  // "filtered from" qualifier keys off the pre-shard list, not the slice: a shard of an
  // unfiltered run is `166 fixtures (shard 1/4)`, never "filtered from".
  let scope = `${String(names.length)} fixtures`;
  const qualifiers: string[] = [];
  if (filteredCount !== allCount) {
    qualifiers.push(`filtered from ${String(allCount)}`);
  }
  if (shard !== undefined) {
    qualifiers.push(`shard ${String(shard.index)}/${String(shard.total)}`);
  }
  if (qualifiers.length > 0) {
    scope += ` (${qualifiers.join(', ')})`;
  }
  process.stdout.write(
    `subset: ${scope} — ${String(passed)} passed, ` +
      `${String(expectedFail)} expected-fail, ${String(failures.length)} failed\n`,
  );
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parseShardArgs(process.argv.slice(2), {
    onUnknownFlag: (arg) => {
      throw new Error(`unknown flag "${arg}"`);
    },
    missingFilterMessage: '--filter requires a value (substring)',
  });
  const allFixtures = subsetNames(HERE);
  const filter = args.filter;
  const only = args.only === undefined ? undefined : readOnlyList(args.only);
  const fixtures = allFixtures.filter(
    (name) =>
      (filter === undefined || name.includes(filter)) && (only === undefined || only.has(name)),
  );

  const allocated = allocatedCodes();

  // `--shards=N`: fan out to N workers of this same runner and merge by fixture index. The merge
  // passes `shard: undefined`, so the printed report is the serial one, byte for byte.
  const shards = runnerShardCount(args, fixtures.length);
  if (shards !== undefined) {
    const script = process.argv[1];
    if (script === undefined) {
      throw new Error('cannot fan out: no script path in process.argv');
    }
    const dir = mkdtempSync(join(tmpdir(), 'stator-subset-'));
    try {
      await fanOutWorkers({
        script,
        baseArgs: workerBaseArgs(args),
        shards,
        dir,
        ...(args.shards === undefined ? { sharedJobs: true } : {}),
      });
      const outcomes = mergeShardFiles({
        dir,
        shards,
        keys: fixtures,
        decode: decodeOutcome,
      });
      printReport(allFixtures.length, fixtures.length, fixtures, outcomes, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }

  // A direct `--shard` is the worker above, run by hand: same slice, human-readable report.
  const slice =
    args.shard === undefined
      ? fixtures.map((name, index) => ({ name, index }))
      : shardSlice(fixtures, args.shard).map((entry) => ({ name: entry.item, index: entry.index }));
  const impact = await impactRecorder('subset', ['packages/tests/subset/']);
  await impact?.loaded();
  const outcomes = await evaluate(
    slice.map((entry) => entry.name),
    allocated,
    impact,
  );
  impact?.finish();
  if (args.jsonOut !== undefined) {
    // Per-item failures are DATA for the driver: exit 0 on a completed slice, nonzero only when
    // the worker itself broke (which `fanOutWorkers` reports as the fatal error).
    writeShardFile(
      args.jsonOut,
      slice.map((entry, position) => {
        const outcome = outcomes[position];
        if (outcome === undefined) {
          throw new Error(`missing outcome for ${entry.name}`);
        }
        return { index: entry.index, key: entry.name, value: encodeOutcome(outcome) };
      }),
    );
    return;
  }
  printReport(
    allFixtures.length,
    fixtures.length,
    slice.map((entry) => entry.name),
    outcomes,
    args.shard,
  );
}

await main();
