/* The ASan golden gate (plan.md §9 Task 6.8, option (a): content-hash skip).
 *
 * `test:asan` is three stages: (1) `just runtime-asan` plus the std archive (`just std`, the
 * one flavor every runtime flavor links), (2) `just runtime-test-asan` plus the `--emit=lib`
 * Check (`ffi/example-c-consumer/static-lib.ts`, Task 7.4), (3) the golden suite
 * linked against the sanitized archive. Stages 1-2 are seconds
 * (incremental objects behind the justfile's `stale()` walk); stage 3 re-runs every
 * fixture's generated C under ASan and is >85% of the cost (plan-notes 244), a
 * duplicate PASS no runtime-cache work can move. This gate runs stages 1-2
 * UNCONDITIONALLY, hashes every input that can change stage 3's outcome, and skips
 * stage 3 — loudly, never silently — when the hash matches the last recorded green:
 *
 * - the sanitized archive, by member content (see below);
 * - `build-asan/link-flags.txt` + `build-asan/cflags.txt` (toolchain/flag key);
 * - the working-tree bytes of every tracked file under the compiler, the golden and
 *   support harnesses, the runtime sources/headers/tests/justfile and the std sources/Zig
 *   backings/justfile (sorted, no
 *   mtimes — `git ls-files` names, bytes off disk, so uncommitted edits count);
 * - the resolved CC's `--version` (same fallback as the justfile and `build.ts`);
 * - the resolved oracle's `node --version` (the same `nodePath()` the golden runner
 *   uses for ground truth);
 * - `uname -sm`, the ambient `ASAN_OPTIONS`/`STATOR_RUNTIME`, and the `typescript`
 *   version string.
 *
 * The record lives at `packages/tests/.asan-last-green.json`: per-tree, never
 * committed (gitignored), written tmp+rename ONLY on a green stage 3 — never on a
 * skip, never on red, so a red run cannot launder itself into the next run's skip.
 * A hash match prints the hash prefix, when it went green, on which commit, with
 * which counts, and the force escape, then exits 0. `STATOR_ASAN_FORCE=1` forces the
 * full pass; CI sets it, so CI always runs everything and the skip exists only for
 * local iteration — the gate a human runs stays complete.
 *
 * `hashGateInputs`/`greenMatches`/record I/O are pure and unit-tested without a
 * toolchain (`packages/tests/unit/asan-gate.test.ts`); `collectGateInputs` is the
 * filesystem half and needs a built `build-asan/` tree. */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { version as typescriptVersion } from 'typescript';
import { nodePath } from '../support/node-path.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const GOLDEN_RUN = join(HERE, 'run.ts');
const STATIC_LIB_RUN = join(HERE, '..', 'ffi', 'example-c-consumer', 'static-lib.ts');

export const RECORD_VERSION = 1;

/* Scopes whose tracked bytes can change stage 3's outcome: the compiler (emitted C),
 * the golden fixtures plus both harnesses that run them, and everything the sanitized
 * archive is built from plus the recipe that builds it. */
const TRACKED_SCOPES: readonly string[] = [
  'packages/compiler/src',
  'packages/tests/golden',
  'packages/tests/support',
  'packages/runtime/src',
  'packages/runtime/include',
  'packages/runtime/tests',
  'packages/runtime/justfile',
  // The std archive is one ReleaseSafe flavor for every runtime flavor (packages/std/justfile),
  // so its bytes follow from its sources and recipe alone.
  'packages/std/src',
  'packages/std/zig',
  'packages/std/justfile',
];

export interface ArchiveMember {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface TrackedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface GateInputs {
  readonly archiveMembers: readonly ArchiveMember[];
  readonly linkFlags: string;
  readonly cflags: string;
  readonly tracked: readonly TrackedFile[];
  readonly ccVersion: string;
  readonly nodeVersion: string;
  readonly uname: string;
  readonly asanOptions: string;
  readonly statorRuntime: string;
  readonly typescriptVersion: string;
}

export interface AsanGreenRecord {
  readonly version: 1;
  readonly hash: string;
  readonly recordedAt: string;
  readonly commit: string;
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
}

export function recordPath(): string {
  return join(REPO, 'packages', 'tests', '.asan-last-green.json');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/* Length-prefixed chunks: an archive byte run ending where a version string begins
 * must not hash the same as the version ending where the bytes begin. */
export function hashGateInputs(inputs: GateInputs): string {
  const hash = createHash('sha256');
  const feedText = (label: string, text: string): void => {
    hash.update(`[${label} ${String(text.length)}:`);
    hash.update(text, 'utf8');
    hash.update(']');
  };
  const feedBytes = (label: string, bytes: Uint8Array): void => {
    hash.update(`[${label} ${String(bytes.byteLength)}:`);
    hash.update(bytes);
    hash.update(']');
  };
  const members = [...inputs.archiveMembers].sort((a, b) => compareStrings(a.name, b.name));
  hash.update(`[archive ${String(members.length)}:`);
  for (const member of members) {
    feedText('member', member.name);
    feedBytes('object', member.bytes);
  }
  hash.update(']');
  feedText('link-flags', inputs.linkFlags);
  feedText('cflags', inputs.cflags);
  const tracked = [...inputs.tracked].sort((a, b) => compareStrings(a.path, b.path));
  hash.update(`[tracked ${String(tracked.length)}:`);
  for (const file of tracked) {
    feedText('path', file.path);
    feedBytes('file', file.bytes);
  }
  hash.update(']');
  feedText('cc', inputs.ccVersion);
  feedText('node', inputs.nodeVersion);
  feedText('uname', inputs.uname);
  feedText('asan-options', inputs.asanOptions);
  feedText('stator-runtime', inputs.statorRuntime);
  feedText('typescript', inputs.typescriptVersion);
  return hash.digest('hex');
}

export function readGreenRecord(path: string): AsanGreenRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const { version, hash, recordedAt, commit, passed, failed, total } = record;
  if (
    version !== RECORD_VERSION ||
    typeof hash !== 'string' ||
    typeof recordedAt !== 'string' ||
    typeof commit !== 'string' ||
    typeof passed !== 'number' ||
    typeof failed !== 'number' ||
    typeof total !== 'number'
  ) {
    return undefined;
  }
  return { version: RECORD_VERSION, hash, recordedAt, commit, passed, failed, total };
}

export function writeGreenRecord(path: string, record: AsanGreenRecord): void {
  const tmp = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function greenMatches(record: AsanGreenRecord | undefined, hash: string): boolean {
  return record !== undefined && record.hash === hash;
}

export function isForceRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['STATOR_ASAN_FORCE'] === '1';
}

export function formatSkipLine(record: AsanGreenRecord, hash: string): string {
  const commit = record.commit.length > 7 ? record.commit.slice(0, 7) : record.commit;
  return (
    `asan: SKIPPED stage 3 (golden-asan) — inputs unchanged since ${record.recordedAt} ` +
    `(commit ${commit}, ${String(record.passed)}/${String(record.total)} passed), ` +
    `hash ${hash.slice(0, 12)}…; STATOR_ASAN_FORCE=1 forces the full pass\n`
  );
}

/* The same CC fallback the justfile and `build.ts` use for sanitized links, so the
 * hashed compiler is the one stage 3 links with. An explicit `CC` wins in all three. */
function resolveCC(): string {
  const override = process.env['CC'];
  if (override !== undefined && override !== '') {
    return override;
  }
  if (process.platform === 'darwin' && existsSync('/usr/bin/clang')) {
    return '/usr/bin/clang';
  }
  return 'clang';
}

function resolveAR(): string {
  const override = process.env['AR'];
  return override !== undefined && override !== '' ? override : 'ar';
}

function firstLine(command: string, args: readonly string[]): string {
  try {
    const result = spawnSync(command, [...args], { encoding: 'utf8' });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const line = stdout.split('\n')[0]?.trim() ?? '';
    return line === '' ? `${command}: no version output` : line;
  } catch {
    return `${command}: unavailable`;
  }
}

/* The archive is hashed by MEMBER CONTENT, not by raw `libjsrt.a` bytes —
 * deliberately. Measured on this host (2026-09-14): `rm -f libjsrt.a && ar rcs …`
 * (the recipe's own archival step) yields different bytes on back-to-back no-change
 * runs while every member is byte-identical — the derived `__.SYMDEF` index embeds
 * a fresh timestamp each time. Hashing raw archive bytes would therefore never match
 * and the gate would never skip. The linker reads members plus the derived index,
 * never the packaging, so member names + bytes cover every input that can change
 * the outcome; header metadata (mtime/uid/gid/mode) cannot. A source touch still
 * re-triggers: `stale()` rebuilds that object, which changes its member's bytes. */
function listArchiveMembers(archive: string): string[] {
  const out = execFileSync(resolveAR(), ['t', archive], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('__.SYMDEF') && line !== '//' && line !== '/')
    .sort();
}

function readArchiveMember(archive: string, member: string): Uint8Array {
  // `ar p` prints the whole member to stdout, and execFileSync caps buffered stdout at 1 MiB
  // by default: an ASan-instrumented member past that (vendor_libregexp.o is already 0.6 MiB
  // on macOS; Linux objects run larger) dies as `spawnSync ar ENOBUFS` instead of hashing.
  // The gate already holds every member in memory for the digest, so a roomy cap — the same
  // 64 MiB the golden-asan spawn below uses — only moves the ceiling far past any member.
  return execFileSync(resolveAR(), ['p', archive, member], { maxBuffer: 64 * 1024 * 1024 });
}

function listTrackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', ...TRACKED_SCOPES], {
    encoding: 'utf8',
    cwd: REPO,
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
}

function currentCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: REPO }).trim();
  } catch {
    return 'unknown';
  }
}

export function collectGateInputs(): GateInputs {
  const dir = join(REPO, 'packages', 'runtime', 'build-asan');
  const archive = join(dir, 'libjsrt.a');
  const archiveMembers: ArchiveMember[] = listArchiveMembers(archive).map((name) => ({
    name,
    bytes: readArchiveMember(archive, name),
  }));
  const tracked: TrackedFile[] = listTrackedFiles().map((path) => ({
    path,
    bytes: readFileSync(join(REPO, path)),
  }));
  return {
    archiveMembers,
    linkFlags: readFileSync(join(dir, 'link-flags.txt'), 'utf8'),
    cflags: readFileSync(join(dir, 'cflags.txt'), 'utf8'),
    tracked,
    ccVersion: firstLine(resolveCC(), ['--version']),
    nodeVersion: firstLine(nodePath(), ['--version']),
    uname: firstLine('uname', ['-s', '-m']),
    asanOptions: process.env['ASAN_OPTIONS'] ?? '',
    statorRuntime: process.env['STATOR_RUNTIME'] ?? '',
    typescriptVersion,
  };
}

function runJust(
  pkg: 'runtime' | 'std',
  recipe: 'runtime-asan' | 'runtime-test-asan' | 'std',
): void {
  const dir = join(REPO, 'packages', pkg);
  const justfile = join(dir, 'justfile');
  const result = spawnSync('just', ['-f', justfile, '-d', dir, recipe], {
    stdio: 'inherit',
    env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' },
  });
  if (result.status !== 0) {
    throw new Error(`just ${recipe} failed (exit ${String(result.status)})`);
  }
}

function parseGoldenCounts(output: string): {
  passed: number;
  failed: number;
  total: number;
} {
  const match = /golden: (\d+) fixtures — (\d+) passed, (\d+) failed/.exec(output);
  if (match === null) {
    return { passed: 0, failed: 0, total: 0 };
  }
  return {
    total: Number(match[1] ?? '0'),
    passed: Number(match[2] ?? '0'),
    failed: Number(match[3] ?? '0'),
  };
}

/* Stage 3 with the sanitizer pinned on: the archive it links was built with
 * `-fsanitize=address,undefined`, and the final link needs the same flags, which
 * `STATOR_RUNTIME=asan` selects in `build.ts`. Stdout is tee'd through so the run
 * reads exactly like a direct golden run; the summary line is parsed back only for
 * the record's counts. */
function runGoldenAsan(): { status: number; passed: number; failed: number; total: number } {
  const result = spawnSync(process.execPath, [GOLDEN_RUN], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, STATOR_RUNTIME: 'asan', ASAN_OPTIONS: 'detect_leaks=0' },
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  process.stdout.write(stdout);
  const counts = parseGoldenCounts(stdout);
  return { status: result.status ?? 1, ...counts };
}

/* Stage 2b, unconditional like stages 1-2 and as cheap: the `--emit=lib` Check (plan.md §10
 * Task 7.4) against the sanitized runtime -- two private runtime copies in one program, under
 * ASan/UBSan and forced Boehm collections. */
function runStaticLibAsan(): void {
  const result = spawnSync(process.execPath, [STATIC_LIB_RUN], {
    stdio: 'inherit',
    env: { ...process.env, STATOR_RUNTIME: 'asan', ASAN_OPTIONS: 'detect_leaks=0' },
  });
  if (result.status !== 0) {
    throw new Error(`static-lib under asan failed (exit ${String(result.status)})`);
  }
}

function runThreadsAsan(): void {
  const result = spawnSync(
    process.execPath,
    [
      join(REPO, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'packages/tests/vitest.config.ts',
      'packages/tests/unit/std.test.ts',
      '--testNamePattern',
      'std/(thread|sync)|std/fs Promise',
    ],
    {
      cwd: REPO,
      env: { ...process.env, STATOR_RUNTIME: 'asan', ASAN_OPTIONS: 'detect_leaks=0' },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0)
    throw new Error(`threads under asan failed (exit ${String(result.status)})`);
}

function main(): void {
  const forced = isForceRequested();
  // Stages 1-2 run on EVERY invocation: they are the seconds-long incremental half,
  // and the hash below is only meaningful against the archive they just produced.
  runJust('runtime', 'runtime-asan');
  runJust('std', 'std');
  runJust('runtime', 'runtime-test-asan');
  runStaticLibAsan();
  runThreadsAsan();
  const hash = hashGateInputs(collectGateInputs());
  const path = recordPath();
  const record = readGreenRecord(path);
  if (!forced && record !== undefined && greenMatches(record, hash)) {
    process.stdout.write(formatSkipLine(record, hash));
    return;
  }
  if (forced) {
    process.stdout.write('asan: STATOR_ASAN_FORCE=1 — running the full golden-asan pass\n');
  } else if (record === undefined) {
    process.stdout.write('asan: no green record — running the full golden-asan pass\n');
  } else {
    process.stdout.write(
      `asan: inputs changed since ${record.recordedAt} — running the full golden-asan pass\n`,
    );
  }
  const run = runGoldenAsan();
  if (run.status !== 0) {
    // Red stays red: no record write, so the next run re-runs the full pass.
    process.exitCode = 1;
    return;
  }
  writeGreenRecord(path, {
    version: RECORD_VERSION,
    hash,
    recordedAt: new Date().toISOString(),
    commit: currentCommit(),
    passed: run.passed,
    failed: run.failed,
    total: run.total,
  });
  process.stdout.write(`asan: golden-asan green — recorded ${hash.slice(0, 12)}…\n`);
}

/* Importable without side effects for the unit test (the test262 runner's pattern);
 * `golden/run.ts` has no such guard, this file must. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(`asan: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
