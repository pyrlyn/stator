/* The GC hygiene test (plan.md §7 Task 4.5): compile a loop that allocates ten million objects and
 * watch the process's RSS while it runs, then do the same for the FFI string-conversion loop
 * (strings.ts) and the computed-key read loop (keys.js, T16) — one watcher, one cap, one plateau
 * rule, a row per loop in FIXTURES below.
 *
 * This is the one test that can tell whether the rooting discipline is doing its job END TO END.
 * The frame audit (tests/unit/frames.test.ts) proves the emitted C declares the slots it writes;
 * the golden tests prove the answers are right. Neither would notice a runtime that simply never
 * frees — a program that allocates 10M objects and keeps every one of them prints exactly the same
 * number as one that collects. Only the memory says which happened.
 *
 * The measurement is RSS sampled from `ps`, not a counter the runtime keeps, because a counter
 * would be the runtime grading its own homework. What is asserted is a PLATEAU, never a specific
 * figure: the peak stays inside a bound no non-collecting run could meet, and the tail does not
 * keep climbing. Ten million two-field objects are ~320 MB if nothing is ever freed, so a cap of
 * 64 MB separates the two outcomes by a factor of five — wide enough that allocator bookkeeping,
 * a different page size, or a differently tuned collector cannot move a passing run across it.
 *
 * Boehm is optional (`pkg-config bdw-gc`), and without it the runtime is plain malloc with no
 * collection — by design, and documented as such. There is no plateau to find in that build, so
 * this test REPORTS that it did not run rather than failing, and rather than passing quietly.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePath } from '../support/node-path.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CLI = join(REPO, 'compiler', 'src', 'cli', 'main.ts');

/** One allocation loop this test watches. `objects` is the original Task 4.5 corpus; `strings`
 * is the FFI conversion loop (see strings.ts). Every row shares the sampling, the cap, and the
 * plateau rule below — the per-iteration byte arithmetic that keeps each outcome ≥5x clear of
 * the cap lives in the fixture headers. */
interface LeakFixture {
  /** Entry file, relative to this directory. */
  readonly file: string;
  /** Report label: the objects row keeps today's `leak: 10M objects — ...` line byte-for-byte. */
  readonly label: string;
  /** Extra Node arguments ahead of the entry for the oracle run. The strings loop calls an
   * extern the Stator side lowers to a direct C call; under Node that name needs its JS mirror
   * preloaded — the golden runner's `--import node_shim.ts` pattern, pointed at the landed shim
   * whose bindings the fixture's declarations already match. */
  readonly nodeArgs: readonly string[];
  /** Extra `stator build` arguments after `-o`. A `.js` entry needs `--mode=js`. */
  readonly buildArgs?: readonly string[];
}

const FIXTURES: readonly LeakFixture[] = [
  { file: 'objects.ts', label: '10M objects', nodeArgs: [] },
  {
    file: 'strings.ts',
    label: '10M FFI strings',
    nodeArgs: ['--import', join(HERE, '..', 'golden', 'ts', 'extern_strstr', 'node_shim.ts')],
  },
  { file: 'keys.js', label: '2M computed-key reads', nodeArgs: [], buildArgs: ['--mode=js'] },
];

/** A runtime that never collects needs ~320 MB for this fixture; one that does needs a few. */
const RSS_CAP_KB = 64 * 1024;
const SAMPLE_MS = 25;

/** Whether the archive this build links was compiled against Boehm — the same file the CLI reads
 * to link it, so the answer here and the answer at link time are one answer. */
function collecting(): boolean {
  const flags = join(REPO, 'runtime', 'build', 'link-flags.txt');
  return existsSync(flags) && readFileSync(flags, 'utf8').includes('-lgc');
}

function compile(fixture: LeakFixture, out: string): void {
  const build = spawnSync(
    process.execPath,
    [CLI, 'build', join(HERE, fixture.file), '-o', out, ...(fixture.buildArgs ?? [])],
    { encoding: 'utf8' },
  );
  if (build.status !== 0) {
    throw new Error(`stator build failed: ${build.stderr.trim()}`);
  }
}

function rssOf(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out === '' ? null : Number(out);
  } catch {
    return null; // the process exited between the loop's check and the call
  }
}

interface Run {
  readonly stdout: string;
  readonly status: number | null;
  readonly samples: readonly number[];
}

async function runSampled(binary: string): Promise<Run> {
  const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'inherit'] });
  const samples: number[] = [];
  const timer = setInterval(() => {
    if (child.pid === undefined) {
      return;
    }
    const rss = rssOf(child.pid);
    if (rss !== null) {
      samples.push(rss);
    }
  }, SAMPLE_MS);
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  const status = await new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      clearInterval(timer);
      resolve(code);
    });
  });
  return { stdout, status, samples };
}

/** Node's own answer for the fixture: the loop must actually compute what it claims to, or a
 * runtime could pass the memory bound by not allocating at all. The oracle path, never the
 * compiler host — see `nodePath`. */
function expected(fixture: LeakFixture): string {
  const node = spawnSync(nodePath(), [...fixture.nodeArgs, join(HERE, fixture.file)], {
    encoding: 'utf8',
  });
  if (node.status !== 0) {
    throw new Error(`node exited ${String(node.status)}: ${node.stderr.trim()}`);
  }
  return node.stdout;
}

async function main(fixture: LeakFixture): Promise<void> {
  if (!collecting()) {
    process.stdout.write(
      'leak: SKIPPED — the runtime was built without Boehm (plain malloc, no collection). ' +
        'Install bdw-gc (macOS: `brew install bdw-gc`; Debian: `apt install libgc-dev`) and ' +
        'rebuild with `just runtime` to run it.\n',
    );
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'stator-leak-'));
  let run: Run;
  try {
    const binary = join(work, 'leak');
    compile(fixture, binary);
    run = await runSampled(binary);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const problems: string[] = [];
  if (run.status !== 0) {
    problems.push(`the compiled program exited ${String(run.status)}`);
  }
  if (run.stdout !== expected(fixture)) {
    problems.push(
      `stdout ${JSON.stringify(run.stdout)} is not Node's ${JSON.stringify(expected(fixture))}`,
    );
  }
  if (run.samples.length < 3) {
    problems.push(
      `only ${String(run.samples.length)} RSS samples — the run was too short to judge`,
    );
  }

  const peak = run.samples.length === 0 ? 0 : Math.max(...run.samples);
  if (peak > RSS_CAP_KB) {
    problems.push(
      `peak RSS ${String(peak)} KB is above the ${String(RSS_CAP_KB)} KB cap — nothing was collected`,
    );
  }
  // A plateau, not a slope: once the heap is up, the second half of the run must not sit
  // meaningfully above the first. The window is anchored on a VALUE, not a sample index: the run is
  // under a second and `ps` yields ~20 samples, so a "middle third" could still be process startup
  // (32 KB observed) and the steady-state 3 MB tail then read as a 94x climb — a red build from
  // scheduler jitter, which is exactly the dishonest signal plan.md §9 exists to keep out.
  const rampEnd = run.samples.findIndex((kb) => kb >= peak / 2);
  const steady = rampEnd < 0 ? [] : run.samples.slice(rampEnd);
  const half = Math.floor(steady.length / 2);
  if (half >= 1) {
    const early = Math.max(...steady.slice(0, half));
    const late = Math.max(...steady.slice(half));
    if (late > early * 1.5) {
      problems.push(`RSS climbed from ${String(early)} KB to ${String(late)} KB — no plateau`);
    }
  }

  for (const problem of problems) {
    process.stderr.write(`FAIL leak: ${problem}\n`);
  }
  process.stdout.write(
    `leak: ${fixture.label} — peak RSS ${String(peak)} KB of a ${String(RSS_CAP_KB)} KB cap, ` +
      `${String(run.samples.length)} samples, ${problems.length === 0 ? 'plateau' : 'FAILED'}\n`,
  );
  if (problems.length > 0) {
    process.exitCode = 1;
  }
}

for (const fixture of FIXTURES) {
  await main(fixture);
}
