/* The process pool the test runners share.
 *
 * Task 6.1 built the first one (plan.md §9) because a serial Test262 pass is ~5 hours and a
 * conformance heartbeat nobody can afford to run is the same as not having one. The subset and
 * golden runners have the same shape — hundreds of `stator` spawns, each independent — and were
 * still serial, so this is that pool extracted rather than copied a third time (AGENTS.md: find the
 * existing helper and reuse it, or extract one shared helper at the responsible layer).
 *
 * Two invariants the callers depend on, both learned in Task 6.1:
 *
 * - **Results are indexed by ITEM, never by completion order.** A pool finishes out of order by
 *   construction, so a runner that pushed as it went would emit a different failure list on every
 *   run and a different `results.json` on every commit. Ordering the output is what keeps a
 *   parallel run's report diffable against a serial one's.
 * - **Nothing here is keyed by pid.** Anything a worker writes to disk needs a name unique to the
 *   CALL, not to the process: keyed by pid alone, two workers in one process would compile each
 *   other's source and report the answer to the wrong test. Callers get `slot` for that, and
 *   `mkdtemp` is the other correct answer.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';

export interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

function testJobs(env = process.env, cores = availableParallelism()): number {
  const requested = Number.parseInt(env['STATOR_TEST_JOBS'] ?? '', 10);
  return Number.isFinite(requested) && requested > 0 ? requested : cores;
}

/** Async `spawnSync`, so a pool can keep every core busy. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    // Built conditionally: `exactOptionalPropertyTypes` is on, so an explicit `undefined` is not
    // the same as an absent key, and `spawn` treats a present `timeout: undefined` as a real value.
    const spawnOptions = {
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    };
    const child = spawn(command, [...args], spawnOptions);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    // `error` fires without `close` when the spawn itself failed, and WITH it when the timeout
    // killed a running child. Settling on `close` whenever the child exists keeps a caller's
    // temp-file cleanup from racing a process that is still reading its input.
    let settled = false;
    const settle = (status: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ status, stdout, stderr });
    };
    child.on('error', (error: Error) => {
      stderr += `\n${error.message}`;
      if (child.pid === undefined) settle(null);
    });
    child.on('close', (code) => {
      settle(code);
    });
  });
}

/** Run `work` over `items` on a fixed-size pool, one slot per core.
 *
 * Each slot pulls the next item, so a slow compile never idles the others — which a chunked split
 * would, since the chunk holding the one 5-second fixture decides the whole run's wall time. */
export async function pool<T, R>(
  items: readonly T[],
  work: (item: T, slot: number) => Promise<R>,
  jobs?: number,
): Promise<R[]> {
  // Preallocated on purpose: the pool writes every slot by index and never appends, so the length
  // is known before the first item runs.
  // oxlint-disable-next-line unicorn/no-new-array
  const results = new Array<R>(items.length);
  let next = 0;
  // `STATOR_TEST_JOBS` overrides pool width (default: os.availableParallelism()). `=1` forces
  // serial order when comparing against a serial report or when a shared box must not be saturated.
  // An explicit `jobs` (a driver that sizes its own fan-out) wins over both.
  const cores = jobs ?? testJobs();
  const width = Math.max(1, Math.min(cores, items.length));
  await Promise.all(
    Array.from({ length: width }, async (_unused, slot) => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        const item = items[index];
        // A hole SKIPS rather than ends the slot's loop: `noUncheckedIndexedAccess` makes the read
        // `T | undefined`, and returning here would silently truncate the run at the first one.
        if (item === undefined) continue;
        results[index] = await work(item, slot);
      }
    }),
  );
  return results;
}

/* Multiprocess sharding for the in-process runners (subset + golden local-iteration speed).
 *
 * Task 6.6 moved those runners in-process, so their CPU work (`explainFile`, `build()`) runs
 * single-threaded: the pool above still parallelizes SUBPROCESS spawns (golden's clang links and
 * Node oracle runs) but CPU-bound items just interleave on one core. `--shard=N/M` slices the
 * item list round-robin and `--shards=N` fans out to N `process.execPath` workers of the same
 * runner, merging the per-item records back by INDEX — the same ordering invariant the pool
 * documents above. Full runs choose bounded sharding automatically; focused runs remain
 * in-process. The serial and merged reports stay byte-identical.
 */

/** One slice of a `--shard=N/M` run: the Nth worker of M total, both 1-based. */
export interface Shard {
  readonly index: number;
  readonly total: number;
}

/** One `--filter` / `--only` / `--shard` / `--shards` / `--json-out` command line, shared by the
 * subset and golden runners so the flag surface cannot drift between the two reports. */
export interface ShardArgs {
  readonly filter: string | undefined;
  /** `--only=<file>`: a list of test keys, one per line (`test:impact`'s selection, plan.md §9
   * Task 6.17). Applies with `--filter`, before `--shard`. */
  readonly only: string | undefined;
  readonly shard: Shard | undefined;
  readonly shards: number | undefined;
  readonly jsonOut: string | undefined;
}

/** Full corpora amortize process startup; focused runs and coverage attribution stay in-process.
 * Cap automatic workers at four and budget 2 GiB each for independent TypeScript heaps. */
export function runnerShardCount(
  args: ShardArgs,
  itemCount: number,
  resources = { cores: availableParallelism(), memory: totalmem(), env: process.env },
): number | undefined {
  if (args.shards !== undefined) return args.shards;
  if (
    args.shard !== undefined ||
    args.filter !== undefined ||
    args.only !== undefined ||
    resources.env['STATOR_IMPACT_RECORD'] !== undefined ||
    itemCount < 32
  ) {
    return undefined;
  }
  const jobs = testJobs(resources.env, resources.cores);
  const count = Math.min(4, resources.cores, jobs, Math.floor(resources.memory / (2 * 1024 ** 3)));
  return count > 1 ? count : undefined;
}

/** Parse the shared sharding flags; `policy` keeps each runner's historical behavior where the
 * two deliberately differ (subset rejects unknown flags loudly, golden ignores them — both
 * predate sharding and are not this helper's to unify). `--filter` applies BEFORE `--shard`,
 * so a shard always slices the filtered list. */
export function parseShardArgs(
  argv: readonly string[],
  policy: {
    readonly onUnknownFlag: (arg: string) => void;
    readonly missingFilterMessage: string;
  },
): ShardArgs {
  let filter: string | undefined;
  let only: string | undefined;
  let jsonOut: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--filter') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(policy.missingFilterMessage);
      }
      filter = value;
      index += 1;
    } else if (arg !== undefined && arg.startsWith('--filter=')) {
      filter = arg.slice('--filter='.length);
    } else if (arg !== undefined && arg.startsWith('--only=')) {
      only = arg.slice('--only='.length);
      if (only === '') {
        throw new Error('--only requires a file path');
      }
    } else if (arg !== undefined && arg.startsWith('--json-out=')) {
      // Worker protocol for `--shards` fan-out: the slice's per-item records go to this file as
      // JSON and nothing human-readable is printed, so the driver owns the one report.
      jsonOut = arg.slice('--json-out='.length);
      if (jsonOut === '') {
        throw new Error('--json-out requires a file path');
      }
    } else if (arg !== undefined && (arg.startsWith('--shard=') || arg.startsWith('--shards='))) {
      // Validated centrally below so a malformed selector and a --shard/--shards conflict read as
      // one error each, not one per loop branch.
    } else if (arg !== undefined) {
      policy.onUnknownFlag(arg);
    }
  }
  const shard = parseShard(argv);
  const shards = parseShardCount(argv);
  if (shard !== undefined && shards !== undefined) {
    throw new Error('--shard and --shards are mutually exclusive');
  }
  if (jsonOut !== undefined && shard === undefined) {
    throw new Error('--json-out requires --shard (it is the worker protocol)');
  }
  return { filter, only, shard, shards, jsonOut };
}

/** The keys of an `--only=<file>` list: one per line, blank lines ignored. */
export function readOnlyList(path: string): ReadonlySet<string> {
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
}

/** The flags a `--shards` driver hands each worker, so a worker slices the driver's list. */
export function workerBaseArgs(args: ShardArgs): string[] {
  return [
    ...(args.filter === undefined ? [] : [`--filter=${args.filter}`]),
    ...(args.only === undefined ? [] : [`--only=${args.only}`]),
  ];
}

/** `--shard=N/M`, spelled exactly as in packages/tests/test262/run.ts (equals form only).
 *
 * Round-robin over the sorted list, not contiguous slices: cost per item varies and clusters by
 * area, so contiguous shards would finish minutes apart and the run would still be paced by its
 * worst one. The filter (when given) applies BEFORE this, so a shard slices the filtered set. */
export function parseShard(argv: readonly string[]): Shard | undefined {
  // `--shards=N` (the fan-out driver below) does not collide with this prefix: its eighth
  // character is `s`, not `=`.
  const flag = argv.find((argument) => argument.startsWith('--shard='));
  if (flag === undefined) return undefined;
  // Split on the FIRST slash by hand rather than one anchored regex: `--shard=1/2/3` must fail
  // on the trailing `/3` (a second number is not a bigger number), and `Number()` alone would
  // also let surrounding whitespace through, which the corpus selectors never carry.
  const body = flag.slice('--shard='.length);
  const slash = body.indexOf('/');
  const head = slash < 0 ? '' : body.slice(0, slash);
  const tail = slash < 0 ? '' : body.slice(slash + 1);
  if (!/^\d+$/.test(head) || !/^\d+$/.test(tail)) {
    throw new Error(`--shard must look like --shard=2/8, got "${flag}"`);
  }
  const index = Number(head);
  const total = Number(tail);
  if (total < 1 || index < 1 || index > total) {
    throw new Error(`--shard needs 1 <= N <= M, got "${flag}"`);
  }
  return { index, total };
}

/** `--shards=N`: run the whole list as N worker processes and merge their records. */
export function parseShardCount(argv: readonly string[]): number | undefined {
  const flag = argv.find((argument) => argument.startsWith('--shards='));
  if (flag === undefined) return undefined;
  const match = /^--shards=(\d+)$/.exec(flag);
  const count = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`expected --shards=N with N >= 1, got ${flag}`);
  return count;
}

/** The shard's items with their positions in the FULL list, so records merge back by index. */
export function shardSlice<T>(
  items: readonly T[],
  shard: Shard,
): { readonly item: T; readonly index: number }[] {
  return items.flatMap((item, index) =>
    index % shard.total === shard.index - 1 ? [{ item, index }] : [],
  );
}

/** One merged-by-index record: where it belongs, what it is, and the runner's payload. */
export interface ShardRecord {
  readonly index: number;
  readonly key: string;
  readonly value: unknown;
}

export function shardFileName(dir: string, index: number, total: number): string {
  return join(dir, `shard-${String(index)}-of-${String(total)}.json`);
}

export function writeShardFile(path: string, records: readonly ShardRecord[]): void {
  writeFileSync(path, `${JSON.stringify(records)}\n`, 'utf8');
}

export function readShardFile(path: string): ShardRecord[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a shard record array`);
  return parsed.map((entry: unknown): ShardRecord => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('index' in entry) ||
      !('key' in entry) ||
      !('value' in entry)
    ) {
      throw new Error(`${path}: malformed shard record`);
    }
    const { index, key, value } = entry;
    if (typeof index !== 'number' || !Number.isInteger(index) || typeof key !== 'string') {
      throw new Error(`${path}: malformed shard record`);
    }
    return { index, key, value };
  });
}

/** Spawn one `--shard=i/N --json-out=…` worker per shard and wait for all of them.
 *
 * `baseArgs` is what the workers share (today: the normalized `--filter=`); the shard selectors
 * are appended here so the driver never re-spells them. Workers inherit this process's env, so
 * `STATOR_TEST_JOBS` (and `TZ`, `STATOR_RUNTIME`, …) apply per worker unless `sharedJobs` divides
 * the subprocess budget for an automatic full run. A worker that exits
 * nonzero is a fatal error — per-item failures are DATA in its shard file, never an exit code. */
export async function fanOutWorkers(options: {
  readonly script: string;
  readonly baseArgs: readonly string[];
  readonly shards: number;
  readonly dir: string;
  readonly sharedJobs?: boolean;
}): Promise<void> {
  const jobs = testJobs();
  // Automatic sharding must not multiply the subprocess pool by the worker count.
  const optionsForWorker: RunOptions = options.sharedJobs
    ? {
        env: {
          ...process.env,
          STATOR_TEST_JOBS: String(Math.max(1, Math.floor(jobs / options.shards))),
        },
      }
    : {};
  const runs = await Promise.all(
    Array.from({ length: options.shards }, (_unused, slot) => {
      const index = slot + 1;
      const args = [
        ...options.baseArgs,
        `--shard=${String(index)}/${String(options.shards)}`,
        `--json-out=${shardFileName(options.dir, index, options.shards)}`,
      ];
      // Compiler-host spawn: the runner is a `.ts` file the host type-strips, so this stays
      // `process.execPath`, never the `nodePath()` oracle (see support/node-path.ts).
      return runProcess(process.execPath, [options.script, ...args], optionsForWorker);
    }),
  );
  const failures: string[] = [];
  for (let slot = 0; slot < runs.length; slot += 1) {
    const result = runs[slot];
    if (result !== undefined && result.status !== 0) {
      failures.push(
        `shard ${String(slot + 1)}: exit ${String(result.status)}: ${result.stderr.trim()}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`${String(failures.length)} shard worker(s) failed\n${failures.join('\n')}`);
  }
}

/** Reassemble the workers' shard files into the full list, indexed by item.
 *
 * `keys` is the driver's own item list: every record's index must land on its key, so a worker
 * that ran a different list (stale checkout, divergent `--filter=`) is a loud error, never a
 * silently shifted report. `decode` validates one runner payload; a missing index (a worker that
 * died after exit 0 without writing it — impossible today, checked anyway) throws naming it. */
export function mergeShardFiles<T>(options: {
  readonly dir: string;
  readonly shards: number;
  readonly keys: readonly string[];
  readonly decode: (value: unknown) => T;
}): T[] {
  // oxlint-disable-next-line unicorn/no-new-array -- preallocated; filled by index, never appended
  const merged = new Array<T>(options.keys.length);
  // oxlint-disable-next-line unicorn/no-new-array -- one flag per item, set as records arrive
  const seen = new Array<boolean>(options.keys.length).fill(false);
  for (let shard = 1; shard <= options.shards; shard += 1) {
    const file = shardFileName(options.dir, shard, options.shards);
    for (const record of readShardFile(file)) {
      const expected = options.keys[record.index];
      if (expected === undefined) {
        throw new Error(`${file}: record index ${String(record.index)} out of range`);
      }
      if (record.key !== expected) {
        throw new Error(
          `${file}: record ${String(record.index)} is "${record.key}", want "${expected}"`,
        );
      }
      if (seen[record.index] === true) {
        throw new Error(`${file}: duplicate record ${String(record.index)}`);
      }
      seen[record.index] = true;
      merged[record.index] = options.decode(record.value);
    }
  }
  for (let index = 0; index < options.keys.length; index += 1) {
    if (seen[index] !== true) {
      throw new Error(`no shard reported item ${String(index)} ("${options.keys[index] ?? '?'}")`);
    }
  }
  return merged;
}
