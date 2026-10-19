/* Golden-test runner (plan.md §5 Task 2.6).
 *
 * Usage: node packages/tests/golden/run.ts [--filter <substring> | --filter=<substring>]
 *          [--only=<file>] [--shard=N/M] [--shards=N]
 *
 * `--only=<file>` runs just the fixtures (`ts/name.ts`, one per line) named in the file — the
 * selection `pnpm run test:impact` hands over (plan.md §9 Task 6.17). It composes with `--filter`.
 *
 * `--shard=N/M` runs one round-robin slice of the (filtered) fixtures; `--shards=N` fans out to
 * N worker processes of this same runner and merges their per-item records back by index, so the
 * merged report is byte-identical to the serial one. Both compose with `--filter`, which applies
 * first. In-process `build()` still shells clang out per fixture, but the TypeScript-host half of
 * the work is single-threaded CPU, so `--shards` is what scales a local iteration with cores;
 * the default stays single-process.
 *
 * Ground truth is the pinned Node in .node-version — that Node and only that Node.
 * Each fixture under tests/golden/ts|js is (a) compiled by stator and executed, and
 * (b) executed directly by Node. stdout must match BYTE-FOR-BYTE, number formatting
 * included (Ryu shortest-round-trip). A mismatch is a semantics bug: never loosen the
 * comparison to make it pass.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InProcessRecorder } from '../impact/recorder.ts';
import { impactRecorder } from '../support/impact-hook.ts';
import {
  fanOutWorkers,
  mergeShardFiles,
  parseShardArgs,
  pool,
  readOnlyList,
  runProcess,
  shardSlice,
  workerBaseArgs,
  writeShardFile,
  type Shard,
} from '../support/parallel.ts';
import {
  buildFixture,
  compileFixtureC,
  runNodeOracle,
  type FixtureStreams,
} from '../support/fixture-build.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/* Every fixture runs with `TZ` PINNED (plan.md §7 Task 4.2, Date step 8). Without it a local-time
 * fixture asserts what the machine's time zone happens to be, which is not a property of the
 * compiler -- and it would pass on the author's laptop and fail in CI, or worse, pass in both for
 * different reasons. UTC specifically, because the compiled binary reads the tzdb through libc's
 * `localtime_r` while Node reads it through ICU: for UTC those two cannot disagree, while for a
 * real zone a tzdata skew between them would surface as a golden diff that looks like a semantics
 * bug and is not. Local-vs-UTC behaviour that UTC makes indistinguishable is proved instead by
 * runtime unit tests under an explicit non-UTC `TZ`, where a disagreement is visible as itself.
 *
 * Applied to BOTH sides, and to the build too so a compile-time constant fold can never see a
 * different zone from the run that checks it. */
const PINNED_ENV = { ...process.env, TZ: 'UTC' };

/* In-process `build()` reads the process environment directly — there is no spawn to carry
 * `PINNED_ENV` — so the pin has to hold here too, for the same reason: a compile-time constant
 * fold must never see a different zone from the run that checks it. */
process.env['TZ'] = 'UTC';

/* Fixtures named `intl_*` exercise the ICU feature build (Task 4.4), which is off by default and
 * may be absent on a machine entirely. They are SKIPPED unless this run links that archive, so
 * `pnpm run ci` stays green without ICU and `pnpm run test:intl` is what turns them on. */
const INTL = process.env['STATOR_RUNTIME'] === 'intl';

/** A directory's entry is `main.<mode>`, except a js-mode graph may enter at `main.cjs` or
 * `main.ts`.
 *
 * js mode compiles TypeScript (plan.md §8 step 5): the point of that fixture is a `.ts` file
 * importing an untyped `.js` module, and looking only for `main.js` would skip it. A `.cjs`
 * entry is CommonJS the bundler takes whole under `--node` (plan.md §11d T12.3). */
function fixtureEntry(dir: string, name: string, mode: 'ts' | 'js'): string {
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

/* Task 6.13: with the default runtime the `intl_*` fixtures never reach the pool, so a
 * summary that counted only what ran would read as if they did not exist. Counted here
 * instead (mirroring `leak: SKIPPED`), so a default run says what it omitted; the gate
 * is unchanged. */
function skippedIntlCount(): number {
  if (INTL) {
    return 0;
  }
  let skipped = 0;
  for (const mode of ['ts', 'js'] as const) {
    let names: string[];
    try {
      names = readdirSync(join(HERE, mode));
    } catch {
      continue;
    }
    skipped += names.filter((name) => name.startsWith('intl_')).length;
  }
  return skipped;
}

/** `--bundler=none` (plan.md §11d T12.1 Check): every fixture builds with the bundle step off,
 * except the ones that import a package from their own `node_modules` (T12.2's `pkg_*`) or enter
 * at a `.cjs` file, which need the bundler and are skipped. The default leaves the compiler's own default, `vite`, which
 * loads `vite-stator` only for those. */
const BUNDLER_NONE = process.argv.includes('--bundler=none');

/** A fixture that ships packages, or enters at a CommonJS file: only the bundler can build it. */
function needsBundler(dir: string, name: string): boolean {
  return existsSync(join(dir, name, 'node_modules')) || existsSync(join(dir, name, 'main.cjs'));
}

interface Fixture {
  readonly mode: 'ts' | 'js';
  readonly path: string;
  readonly name: string;
}

function fixtures(mode: 'ts' | 'js'): Fixture[] {
  const dir = join(HERE, mode);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  // A DIRECTORY is a multi-file fixture: its entry point is `main.<mode>` (`fixtureEntry`) and the other
  // files in it are modules the entry imports. Stator compiles the whole graph from the
  // entry; Node likewise runs just the entry — both resolve the imports themselves.
  return names
    .filter(
      (name) =>
        (INTL || !name.startsWith('intl_')) &&
        !(BUNDLER_NONE && needsBundler(dir, name)) &&
        (name.endsWith(`.${mode}`) ||
          statSync(join(dir, name), { throwIfNoEntry: false })?.isDirectory()),
    )
    .sort()
    .map((name) => ({
      mode,
      name,
      path: fixtureEntry(dir, name, mode),
    }));
}

/* `--filter <substring>` (or `--filter=<substring>`) narrows the run to fixtures whose
 * `mode/name` contains the substring — developer iteration speed, so debugging five fixtures
 * does not compile two hundred. Applies after the `intl_*` skip, before the pool; the summary
 * counts what ran, and a filter that matches nothing prints the zero-line and exits 0. Flag
 * parsing itself lives in support/parallel.ts (`parseShardArgs`), shared with the subset runner
 * so the two reports cannot drift apart. */

function fixtureKey(fixture: Fixture): string {
  return `${fixture.mode}/${fixture.name}`;
}

/* A per-fixture failure line, or `undefined` for a pass. Hoisted to module scope as the shard
 * payload: `null` on the wire, `undefined` in memory. */
function encodeFailure(failure: string | undefined): unknown {
  return failure ?? null;
}

function decodeFailure(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value === 'string') return value;
  throw new Error('shard record value is not a failure string or null');
}

/* `mkdtemp` — not a slot-keyed name — is what makes this safe to run on the pool: the output
 * binary and its intermediates live in a directory unique to THIS CALL, so two workers can never
 * compile into each other's `app`. */

/** Fixtures named `node_*` build on the `--node` platform (plan.md §11c T11.6, docs/MODES.md
 * §6): their `node:*` imports resolve to `packages/node`, and Node runs them like any fixture. */
function onNodePlatform(fixture: Fixture): boolean {
  return fixture.name.startsWith('node_');
}

/** A fixture's `// @args: a b` line: the arguments both runs get after the program, split on
 * spaces (`process.argv.slice(2)` reads them; docs/MODES.md §6). None when the line is absent. */
function programArgs(fixture: Fixture): string[] {
  const line = /^\/\/ @args:(.*)$/m.exec(readFileSync(fixture.path, 'utf8'));
  return (
    line?.[1]
      ?.trim()
      .split(/\s+/)
      .filter((arg) => arg !== '') ?? []
  );
}

async function runCompiled(fixture: Fixture): Promise<FixtureStreams> {
  const { path, mode } = fixture;
  const work = mkdtempSync(join(tmpdir(), 'stator-golden-'));
  try {
    const out = join(work, 'app');
    const objects = await compileFixtureC(path, dirname(out));
    await buildFixture({
      entry: path,
      out,
      mode,
      linkFlags: objects,
      node: onNodePlatform(fixture),
      ...(BUNDLER_NONE ? { bundler: { kind: 'none' } } : {}),
    });
    const exec = await runProcess(out, programArgs(fixture), { env: PINNED_ENV });
    if (exec.status !== 0) {
      throw new Error(`compiled binary exited ${String(exec.status)}: ${exec.stderr.trim()}`);
    }
    return { stdout: exec.stdout, stderr: exec.stderr };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* One result per fixture, indexed by fixture: the pool completes out of order, and a golden
 * report whose failure order shifted run to run would be unreadable as a diff. With an impact
 * recorder the pool is one wide (the recorder insists), so the take after each fixture holds
 * exactly what that fixture ran — its binary's runtime members included. */
async function collect(
  all: readonly Fixture[],
  impact: InProcessRecorder | undefined,
): Promise<(string | undefined)[]> {
  return pool(all, async (fixture): Promise<string | undefined> => {
    const result = await check(fixture);
    await impact?.take(fixtureKey(fixture));
    return result;
  });
}

async function check(fixture: Fixture): Promise<string | undefined> {
  try {
    const [actual, expected] = await Promise.all([
      runCompiled(fixture),
      runNodeOracle(fixture.path, PINNED_ENV, programArgs(fixture)),
    ]);
    if (actual.stdout === expected.stdout && actual.stderr === expected.stderr) {
      return undefined;
    }
    const stream = actual.stdout === expected.stdout ? 'stderr' : 'stdout';
    return `${fixture.mode}/${fixture.name}: ${stream} differs\n  stator: ${JSON.stringify(actual[stream])}\n  node:   ${JSON.stringify(expected[stream])}`;
  } catch (error) {
    return `${fixture.mode}/${fixture.name}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/* The one report, shared verbatim by the serial run, a direct `--shard` slice, and the merged
 * `--shards` run — a second copy here would be a second definition of "the golden result". A
 * `shard` names the slice honestly; `undefined` is the whole (filtered) list, byte-identical to
 * the pre-sharding report. */
function printReport(
  total: number,
  failures: readonly (string | undefined)[],
  shard: Shard | undefined,
): void {
  const failed = failures.filter((result) => result !== undefined);
  const passed = total - failed.length;

  for (const failure of failed) {
    process.stderr.write(`FAIL ${failure}\n`);
  }
  const where = shard === undefined ? '' : ` (shard ${String(shard.index)}/${String(shard.total)})`;
  process.stdout.write(
    `golden: ${String(total)} fixtures${where} — ${String(passed)} passed, ${String(failed.length)} failed\n`,
  );
  const skippedIntl = skippedIntlCount();
  if (skippedIntl > 0) {
    process.stdout.write(
      `golden: SKIPPED ${String(skippedIntl)} intl_* fixtures (STATOR_RUNTIME is not intl; run \`pnpm run test:intl\` to include them)\n`,
    );
  }
  if (BUNDLER_NONE) {
    const dir = join(HERE, 'js');
    const packaged = readdirSync(dir).filter((name) => needsBundler(dir, name)).length;
    process.stdout.write(
      `golden: SKIPPED ${String(packaged)} fixtures that import packages (--bundler=none)\n`,
    );
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parseShardArgs(process.argv.slice(2), {
    // Historical leniency: golden has always ignored unknown flags rather than failing the run.
    onUnknownFlag: (_arg: string): void => {},
    missingFilterMessage: '--filter requires a value',
  });
  const filter = args.filter;
  const only = args.only === undefined ? undefined : readOnlyList(args.only);
  const filtered = [...fixtures('ts'), ...fixtures('js')].filter(
    (fixture) =>
      (filter === undefined || fixtureKey(fixture).includes(filter)) &&
      (only === undefined || only.has(fixtureKey(fixture))),
  );

  // `--shards=N`: fan out to N workers of this same runner and merge by fixture index. The merge
  // passes `shard: undefined`, so the printed report is the serial one, byte for byte.
  if (args.shards !== undefined) {
    const script = process.argv[1];
    if (script === undefined) {
      throw new Error('cannot fan out: no script path in process.argv');
    }
    const dir = mkdtempSync(join(tmpdir(), 'stator-golden-'));
    try {
      await fanOutWorkers({
        script,
        baseArgs: [...workerBaseArgs(args), ...(BUNDLER_NONE ? ['--bundler=none'] : [])],
        shards: args.shards,
        dir,
      });
      const results = mergeShardFiles({
        dir,
        shards: args.shards,
        keys: filtered.map((fixture) => fixtureKey(fixture)),
        decode: decodeFailure,
      });
      printReport(filtered.length, results, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }

  // A direct `--shard` is the worker above, run by hand: same slice, human-readable report.
  const slice =
    args.shard === undefined
      ? filtered.map((fixture, index) => ({ fixture, index }))
      : shardSlice(filtered, args.shard).map((entry) => ({
          fixture: entry.item,
          index: entry.index,
        }));
  // The ASan stage of `test:asan` runs this same runner; its map record is its own harness.
  const impact = await impactRecorder(
    process.env['STATOR_RUNTIME'] === 'asan' ? 'asan' : 'golden',
    ['packages/tests/golden/ts/', 'packages/tests/golden/js/'],
  );
  await impact?.loaded();
  const results = await collect(
    slice.map((entry) => entry.fixture),
    impact,
  );
  impact?.finish();
  if (args.jsonOut !== undefined) {
    // Per-item failures are DATA for the driver: exit 0 on a completed slice, nonzero only when
    // the worker itself broke (which `fanOutWorkers` reports as the fatal error).
    writeShardFile(
      args.jsonOut,
      slice.map((entry, position) => {
        if (position >= results.length) {
          throw new Error(`missing result for ${fixtureKey(entry.fixture)}`);
        }
        const result: string | undefined = results[position];
        return {
          index: entry.index,
          key: fixtureKey(entry.fixture),
          value: encodeFailure(result),
        };
      }),
    );
    return;
  }
  printReport(slice.length, results, args.shard);
}

await main();
