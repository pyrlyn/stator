/* Test262 conformance runner (plan.md §9 Task 6.1).
 *
 * Usage: run.ts [--shard=N/M] [--filter <substring> | --filter=<substring>] [--aggregate <dir>]
 *
 * `--filter` is a debug affordance: it keeps only the tests whose corpus-relative path contains
 * the substring (e.g. `--filter generators`, `--filter async-await`) and runs them as a console
 * slice. It applies BEFORE `--shard`, so `--shard=N/M` selects every Mth test of the FILTERED
 * set, not of the corpus. A filtered run gates nothing (no ratchet, no expected-fail.txt check),
 * writes no result files (a slice must never pose as `results.json` or as a shard `--aggregate`
 * would merge), and always exits 0 — inspect the counts. Combining `--filter` with `--aggregate`
 * is a loud error for the same reason: aggregating a slice would publish it as the corpus. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, BuildError, withDiagnosticCapture } from '../../compiler/src/cli/build.ts';
import { pool, runProcess, type ProcessResult } from '../support/parallel.ts';
import { featureStatus } from './features.ts';

export interface Test262Frontmatter {
  readonly esid?: string;
  readonly features: readonly string[];
  readonly includes: readonly string[];
  readonly flags: readonly string[];
  readonly negative?: { readonly phase: string; readonly type: string };
  readonly locale?: readonly string[];
}

export interface Test262Result {
  readonly path: string;
  readonly verdict: 'passed' | 'failed' | 'skipped';
  readonly reason?: string;
  readonly features: readonly string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = join(HERE, 'corpus');
const RESULTS = join(HERE, 'results.json');
const PIN = join(HERE, 'pin.json');
const EXECUTION_KEYS = new Set(['esid', 'features', 'includes', 'flags', 'negative', 'locale']);
// Test262's standard header also carries descriptive information that does not affect how a test
// is built. It must be recognized rather than mistaken for a corpus-format change, while a new
// top-level key remains an error (plan.md §9 Task 6.1).
const DESCRIPTIVE_KEYS = new Set(['author', 'description', 'es5id', 'es6id', 'info']);
// `generated` says the file came out of the project's own tooling; INTERPRETING.md gives it no
// execution meaning at all, and it is on 17,003 of the corpus's 53,874 files. Treating it as an
// unimplemented flag skipped nearly a third of Test262 for a provenance note (plan-notes 176).
const ALLOWED_FLAGS = new Set(['raw', 'onlyStrict', 'noStrict', 'module', 'async', 'generated']);
const ASYNC_COMPLETE = 'Test262:AsyncTestComplete';
/** How many unexplained failures to print in full before falling back to the count alone. */
const UNEXPLAINED_SAMPLE = 20;
/** Wall-clock ceiling for one compiled program (and a best-effort race for in-process build). */
const PROCESS_TIMEOUT_MS = 30_000;
const DIAGNOSTIC_ERROR_CLASSES: Readonly<Record<string, readonly string[]>> = {
  STA0012: ['SyntaxError'],
  STA2001: ['TypeError'],
  STA2004: ['TypeError'],
  STA2005: ['RangeError', 'SyntaxError', 'TypeError'],
  STA2006: ['TypeError'],
  // An ambiguous `export *` name imported by name: ES's link-time SyntaxError (plan-notes 302).
  STA3003: ['SyntaxError'],
  // A default import of a syntax-free ES module: ES's link-time SyntaxError (plan-notes 350).
  STA3004: ['SyntaxError'],
  // An imported binding named `eval` or `arguments`: a strict-mode early SyntaxError.
  STA3005: ['SyntaxError'],
};

function listValue(raw: string): string[] {
  const value = raw.trim();
  if (value === '' || value === '[]') {
    return [];
  }
  if (!value.startsWith('[') || !value.endsWith(']')) {
    throw new Error(`expected a bracketed list, got ${raw}`);
  }
  return value
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item !== '');
}

function scalar(raw: string): string {
  return raw.trim().replace(/^['"]|['"]$/g, '');
}

/** Parse the Test262 execution metadata; unknown top-level keys are corpus-format errors. */
export function parseFrontmatter(source: string, file = '<source>'): Test262Frontmatter {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '/*---');
  if (start < 0) {
    throw new Error(`${file}: missing /*--- frontmatter`);
  }
  const end = lines.findIndex((line, index) => index > start && line.trim() === '---*/');
  if (end < 0) {
    throw new Error(`${file}: unterminated frontmatter`);
  }
  const features: string[] = [];
  const includes: string[] = [];
  const flags: string[] = [];
  let esid: string | undefined;
  let locale: string[] | undefined;
  let negative: { phase?: string; type?: string } | undefined;
  let pendingList: string[] | undefined;
  let blockScalarIndent: number | undefined;
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i] ?? '';
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (blockScalarIndent !== undefined && (line.trim() === '' || indent >= blockScalarIndent)) {
      continue;
    }
    blockScalarIndent = undefined;
    const listItem = /^\s*-\s*(.+)$/.exec(line);
    if (listItem !== null) {
      if (pendingList === undefined) throw new Error(`${file}: list item without a list key`);
      pendingList.push(scalar(listItem[1] ?? ''));
      continue;
    }
    const match = /^(\s*)([A-Za-z][\w-]*):(?:\s*(.*))?$/.exec(line);
    if (match === null) {
      if (line.trim() === '') continue;
      throw new Error(`${file}: invalid frontmatter line ${line}`);
    }
    const keyIndent = match[1]?.length ?? 0;
    const key = match[2] ?? '';
    const value = match[3] ?? '';
    // A handful of legacy Test262 files indent a descriptive top-level key by one space. The
    // field has no execution meaning, so recognize that historical formatting without treating
    // arbitrary nested metadata as a top-level key.
    const legacyDescriptiveKey = keyIndent === 1 && DESCRIPTIVE_KEYS.has(key);
    if (keyIndent > 0 && !legacyDescriptiveKey) {
      if (negative === undefined || (key !== 'phase' && key !== 'type') || keyIndent < 2) {
        throw new Error(`${file}: unknown nested frontmatter key "${key}"`);
      }
      negative[key] = scalar(value);
      continue;
    }
    pendingList = undefined;
    if (!EXECUTION_KEYS.has(key) && !DESCRIPTIVE_KEYS.has(key)) {
      throw new Error(`${file}: unknown frontmatter key "${key}"`);
    }
    if (/^[>|][+-]?$/.test(value.trim())) {
      blockScalarIndent = 1;
    }
    if (key === 'negative') {
      negative = {};
    } else if (key === 'features' || key === 'includes' || key === 'flags') {
      const target = key === 'features' ? features : key === 'includes' ? includes : flags;
      target.push(...listValue(value));
      if (value.trim() === '') pendingList = target;
    } else if (key === 'esid') {
      esid = scalar(value);
    } else if (key === 'locale') {
      locale =
        value.trim() === ''
          ? []
          : value.trim().startsWith('[')
            ? listValue(value)
            : [scalar(value)];
      if (value.trim() === '') pendingList = locale;
    }
  }
  const parsedNegative =
    negative === undefined ? undefined : { phase: negative.phase, type: negative.type };
  if (
    parsedNegative !== undefined &&
    (parsedNegative.phase === undefined || parsedNegative.type === undefined)
  ) {
    throw new Error(`${file}: negative requires phase and type`);
  }
  return parsedNegative === undefined
    ? {
        ...(esid === undefined ? {} : { esid }),
        features,
        includes,
        flags,
        ...(locale === undefined ? {} : { locale }),
      }
    : {
        ...(esid === undefined ? {} : { esid }),
        features,
        includes,
        flags,
        negative: { phase: parsedNegative.phase ?? '', type: parsedNegative.type ?? '' },
        ...(locale === undefined ? {} : { locale }),
      };
}

function corpusRoot(): string {
  const configured = process.env['STATOR_TEST262'];
  const root = configured ?? DEFAULT_CORPUS;
  return root;
}

function pinnedCommit(): string {
  const parsed: unknown = JSON.parse(readFileSync(PIN, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('commit' in parsed) ||
    typeof parsed.commit !== 'string'
  ) {
    throw new Error(`${PIN}: expected a commit SHA`);
  }
  return parsed.commit;
}

function testFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, name.name);
      if (name.isDirectory()) visit(path);
      // `_FIXTURE` files are imported BY tests and "MUST NOT be interpreted as standalone tests"
      // (INTERPRETING.md). They carry no frontmatter, so enumerating them turned 294 non-tests into
      // reported skips — noise in the one number this task exists to publish.
      else if (name.isFile() && name.name.endsWith('.js') && !name.name.endsWith('_FIXTURE.js'))
        result.push(path);
    }
  };
  visit(join(root, 'test'));
  return result.sort((left, right) => left.localeCompare(right));
}

/** The code that answers for a refused build: the first one the runner can map to an ES error
 * class, else the first one. A gate reports every construct at once, so a test's own refusal
 * (an ambiguous `export *` import, STA3003) can follow a not-yet code the harness raised first --
 * and the refusal, not the schedule, is what the negative test asks about (plan-notes 302). */
function diagnosticCode(stderr: string): string | undefined {
  const codes = [...stderr.matchAll(/\b(STA\d{4})\b/g)].map((match) => match[1] ?? '');
  return codes.find((code) => DIAGNOSTIC_ERROR_CLASSES[code] !== undefined) ?? codes[0];
}

/** The lowest not-yet code in a build that raised NOTHING but not-yet codes.
 *
 * `STA12xx` is schedule, not conformance (plan.md §1.3: the never and not-yet ranges are disjoint
 * so a test can tell intent from schedule), so a test the compiler declines to build yet is a skip
 * attributed to that code — exactly what step 4 already does for a negative test. A build that also
 * raised any other code refused the program for a reason of its own and stays a failure. */
export function scheduleSkipCode(stderr: string): string | undefined {
  const codes = [...stderr.matchAll(/\b(STA\d{4})\b/g)].map((match) => match[1] ?? '');
  if (codes.length === 0 || codes.some((code) => !code.startsWith('STA12'))) return undefined;
  return [...codes].sort()[0];
}

function errorClassMatches(stderr: string, type: string): boolean {
  const code = diagnosticCode(stderr);
  const mapped = code === undefined ? undefined : DIAGNOSTIC_ERROR_CLASSES[code];
  if (mapped !== undefined) return mapped.includes(type);
  return (
    code === undefined &&
    new RegExp(`\\b${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(stderr)
  );
}

/** Harness files repeat across tens of thousands of tests; memoize by absolute path. */
const harnessFileCache = new Map<string, string>();

function readHarnessFile(file: string): string {
  const cached = harnessFileCache.get(file);
  if (cached !== undefined) return cached;
  const text = readFileSync(file, 'utf8');
  harnessFileCache.set(file, text);
  return text;
}

function harnessSource(root: string, path: string, metadata: Test262Frontmatter): string {
  const body = readFileSync(path, 'utf8');
  if (metadata.flags.includes('raw')) return body;
  // The corpus supplies its own assertion library AND its own `sta.js` (`Test262Error`,
  // `$DONOTEVALUATE`); Stator supplies only the host's `$DONE`.
  const files = [
    join(root, 'harness', 'assert.js'),
    join(root, 'harness', 'sta.js'),
    join(HERE, 'harness', 'done.ts'),
    ...metadata.includes.map((name) => join(root, 'harness', name)),
  ];
  const missing = files.find((file) => !existsSync(file));
  if (missing !== undefined) throw new Error(`missing harness file ${missing}`);
  const strict = metadata.flags.includes('onlyStrict') ? `'use strict';\n` : '';
  return `${strict}${files.map((file) => readHarnessFile(file)).join('\n')}\n${body}`;
}

/** In-process compile: same status/stderr shape as the old CLI spawn, without a fresh Node. */
async function buildInProcess(input: string, output: string): Promise<ProcessResult> {
  const work = async (): Promise<ProcessResult> => {
    try {
      const { result: status, stderr } = await withDiagnosticCapture(() =>
        build({ entry: input, out: output, mode: 'js', emitCOnly: false, keepC: false }),
      );
      return { status, stdout: '', stderr };
    } catch (error) {
      // Mirror CLI main.ts: BuildError is status 1 with `stator: CODE message` on stderr.
      if (error instanceof BuildError) {
        return { status: 1, stdout: '', stderr: `stator: ${error.code} ${error.message}\n` };
      }
      // The upstream checker's overflow (Test262's generator-prop-name-yield-expr.js: `var yield`
      // plus a generator method keyed by `[yield]`) now arrives above as BuildError STA0013
      // (plan-notes 287). This is the backstop for a stack overflow anywhere else: in-process that
      // throw would reject the pool worker and kill the whole shard, so it becomes the CLI's
      // STA4072-class per-test FAILURE here instead. Matched narrowly
      // on the call-stack signature: any other RangeError (an OOM-style or allocator failure) is
      // still rethrown, because swallowing a resource failure as a conformance verdict would lie
      // about the run. STA4072 is not an STA12xx code, so the existing classification below records
      // this as failed — never a skip (§9 honesty rules).
      if (error instanceof RangeError && /call stack/i.test(error.message)) {
        return {
          status: 1,
          stdout: '',
          stderr: `stator: STA4072 internal error: ${error.message} — checker stack overflow; this is a compiler bug\n`,
        };
      }
      throw error;
    }
  };
  // Best-effort ceiling only: Promise.race cannot cancel the compile, but a hung build must not
  // stall the pool forever. Slot-scoped temp files keep a timed-out build from clobbering the next.
  return await Promise.race([
    work(),
    new Promise<ProcessResult>((resolve) => {
      setTimeout(() => {
        resolve({
          status: null,
          stdout: '',
          stderr: `build timed out after ${String(PROCESS_TIMEOUT_MS)}ms`,
        });
      }, PROCESS_TIMEOUT_MS);
    }),
  ]);
}

/** Relative module specifiers in `source`: static imports, re-exports and literal `import()`. */
const RELATIVE_SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/** Copy every module `entry` reaches by relative specifier into `dir`, under the same relative
 * path. A module test imports `_FIXTURE` siblings -- and sometimes itself -- by name, so it must
 * compile beside them, not from a renamed temp file (plan-notes 302). The entry itself is never
 * copied: `dir` already holds it, harness included, under its own name. */
function copyModuleSiblings(entry: string, dir: string): void {
  const origin = dirname(entry);
  const pending = [entry];
  const seen = new Set<string>([entry]);
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined) break;
    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_SPECIFIER)) {
      const target = join(dirname(file), match[1] ?? '');
      if (seen.has(target) || !existsSync(target)) continue;
      seen.add(target);
      const copy = join(dir, relative(origin, target));
      mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(target, copy);
      pending.push(target);
    }
  }
}

async function execute(
  path: string,
  root: string,
  metadata: Test262Frontmatter,
  slot: number,
): Promise<Test262Result> {
  const rel = relative(root, path);
  const work = join(HERE, '.tmp');
  mkdirSync(work, { recursive: true });
  // Keyed by the pool slot as well as the pid: two workers sharing one filename would compile each
  // other's source and report the answer to the wrong test.
  // A module test compiles from a directory of its own, under its own name, beside the modules
  // it imports (`copyModuleSiblings`); a script needs no neighbours.
  const isModule = metadata.flags.includes('module');
  const moduleDir = join(work, `module-${process.pid}-${String(slot)}`);
  if (isModule) {
    rmSync(moduleDir, { recursive: true, force: true });
    mkdirSync(moduleDir, { recursive: true });
    copyModuleSiblings(path, moduleDir);
  }
  const input = isModule
    ? join(moduleDir, basename(path))
    : join(work, `test-${process.pid}-${String(slot)}.js`);
  const output = join(work, `test-${process.pid}-${String(slot)}.out`);
  writeFileSync(input, harnessSource(root, path, metadata), 'utf8');
  const compiled = await buildInProcess(input, output);
  try {
    if (metadata.negative?.phase === 'parse' || metadata.negative?.phase === 'resolution') {
      if (compiled.status === 0)
        return {
          path: rel,
          verdict: 'failed',
          reason: 'negative test compiled successfully',
          features: metadata.features,
        };
      const code = diagnosticCode(compiled.stderr);
      if (code?.startsWith('STA12') === true)
        return { path: rel, verdict: 'skipped', reason: code, features: metadata.features };
      return {
        path: rel,
        verdict: errorClassMatches(compiled.stderr, metadata.negative.type) ? 'passed' : 'failed',
        reason: code ?? compiled.stderr.trim(),
        features: metadata.features,
      };
    }
    if (compiled.status !== 0) {
      const pending = scheduleSkipCode(compiled.stderr);
      return pending === undefined
        ? {
            path: rel,
            verdict: 'failed',
            reason: compiled.stderr.trim(),
            features: metadata.features,
          }
        : { path: rel, verdict: 'skipped', reason: pending, features: metadata.features };
    }
    const execution = await runProcess(output, [], { timeoutMs: PROCESS_TIMEOUT_MS });
    if (metadata.negative?.phase === 'runtime') {
      return {
        path: rel,
        verdict:
          execution.status !== 0 && errorClassMatches(execution.stderr, metadata.negative.type)
            ? 'passed'
            : 'failed',
        reason: execution.stderr.trim(),
        features: metadata.features,
      };
    }
    if (metadata.flags.includes('async') && !execution.stdout.includes(ASYNC_COMPLETE)) {
      return {
        path: rel,
        verdict: 'failed',
        reason: `async test did not call $DONE (missing ${ASYNC_COMPLETE})`,
        features: metadata.features,
      };
    }
    return {
      path: rel,
      verdict: execution.status === 0 ? 'passed' : 'failed',
      reason: execution.stderr.trim(),
      features: metadata.features,
    };
  } finally {
    for (const file of [input, output, ...(isModule ? [moduleDir] : [])]) {
      try {
        rmSync(file, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}

function expectedFailures(): Map<string, string> {
  const path = join(HERE, 'expected-fail.txt');
  const entries = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([^#\s]+)\s*#\s*(.+?)\s*$/.exec(line);
    if (match !== null) entries.set(match[1] ?? '', match[2] ?? '');
  }
  return entries;
}

function ratchetCheck(passed: number, failed: number): string[] {
  const parsed: unknown = JSON.parse(readFileSync(join(HERE, 'ratchet.json'), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('passed' in parsed) ||
    !('failed' in parsed) ||
    !('skipped' in parsed) ||
    typeof parsed.passed !== 'number' ||
    typeof parsed.failed !== 'number' ||
    typeof parsed.skipped !== 'number'
  ) {
    throw new Error('ratchet.json must contain numeric passed, failed, and skipped fields');
  }
  const failures: string[] = [];
  if (passed < parsed.passed)
    failures.push(`ratchet: passed dropped from ${String(parsed.passed)} to ${String(passed)}`);
  if (failed > parsed.failed)
    failures.push(`ratchet: failed rose from ${String(parsed.failed)} to ${String(failed)}`);
  return failures;
}

export type ClassifiedTest =
  | { readonly action: 'skip'; readonly result: Test262Result }
  | { readonly action: 'run'; readonly path: string; readonly metadata: Test262Frontmatter };

/** Frontmatter + unsupported flag/feature → immediate result; else needs compile/execute.
 *
 * ~90% of the corpus skips after frontmatter. Doing that synchronously before the pool keeps the
 * workers on tests that actually compile instead of spending slots on feature checks.
 */
export function classify(path: string, root: string): ClassifiedTest {
  const rel = relative(root, path);
  try {
    const metadata = parseFrontmatter(readFileSync(path, 'utf8'), path);
    const unsupportedFlag = metadata.flags.find((flag) => !ALLOWED_FLAGS.has(flag));
    if (unsupportedFlag !== undefined)
      return {
        action: 'skip',
        result: {
          path: rel,
          verdict: 'skipped',
          reason: `flag ${unsupportedFlag}`,
          features: metadata.features,
        },
      };
    const unsupported = metadata.features
      .map((feature) => [feature, featureStatus(feature)] as const)
      .find(([, status]) => status === undefined || status.kind !== 'supported');
    if (unsupported !== undefined) {
      const [feature, status] = unsupported;
      if (status === undefined) throw new Error(`unmapped feature ${feature}`);
      return {
        action: 'skip',
        result: {
          path: rel,
          verdict: 'skipped',
          reason: status.kind === 'not-yet' ? `${status.code} (${feature})` : `never (${feature})`,
          features: metadata.features,
        },
      };
    }
    return { action: 'run', path, metadata };
  } catch (error) {
    if (error instanceof Error && error.message.endsWith('missing /*--- frontmatter'))
      return {
        action: 'skip',
        result: {
          path: rel,
          verdict: 'skipped',
          reason: 'missing frontmatter',
          features: [],
        },
      };
    return {
      action: 'skip',
      result: {
        path: rel,
        verdict: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        features: [],
      },
    };
  }
}

/** `--shard=N/M`: run only every Mth test starting at N (1-based).
 *
 * The whole corpus costs 2-3.5 hours on one runner, which is over CI's per-job ceiling; splitting
 * it is what keeps the number on every commit (plan-notes 198). ROUND-ROBIN over the sorted list,
 * not contiguous slices: cost per test varies by two orders of magnitude and clusters by directory
 * (`built-ins/Temporal` skips on a feature check, `language/expressions` compiles), so contiguous
 * shards would finish minutes and hours apart and the job would still be paced by its worst one. */
function parseShard(argv: readonly string[]): { index: number; total: number } | undefined {
  const flag = argv.find((argument) => argument.startsWith('--shard='));
  if (flag === undefined) return undefined;
  const match = /^--shard=(\d+)\/(\d+)$/.exec(flag);
  if (match === null) throw new Error(`expected --shard=N/M, got ${flag}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index < 1 || index > total)
    throw new Error(`--shard=N/M requires 1 <= N <= M, got ${flag}`);
  return { index, total };
}

function shardResultsPath(index: number, total: number): string {
  return join(HERE, `results-${String(index)}-of-${String(total)}.json`);
}

/** `--filter <substring>` (or `--filter=<substring>`): debug one area without shard mechanics.
 *
 * Matches against the corpus-relative path (`test/language/...`), case-sensitive substring —
 * the same spelling shape as `--shard=N/M` above. First occurrence wins; an empty or missing
 * value is an error, never a match-everything. Returns `undefined` when no `--filter` is given.
 */
function parseFilter(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--filter') {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--'))
        throw new Error('--filter requires a non-empty substring argument');
      return value;
    }
    if (argument.startsWith('--filter=')) {
      const value = argument.slice('--filter='.length);
      if (value === '') throw new Error('--filter requires a non-empty substring, got --filter=');
      return value;
    }
  }
  return undefined;
}

/** Reassemble the shards' results into the one list the gates need.
 *
 * A shard sees a slice, and every gate below is a statement about the CORPUS: the ratchet compares
 * totals, and `expected-fail.txt` says a named test still fails — neither is decidable from a
 * slice, so a shard reports its slice and this is where the run is judged. */
function loadShards(directory: string): Test262Result[] {
  const files = readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /^results-\d+-of-\d+\.json$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  if (files.length === 0) throw new Error(`no shard results under ${directory}`);
  // A shard that died uploaded no artifact, and merging what is left would publish a SMALLER
  // corpus as if it were the whole one -- fewer failures reads as a conformance win and sails past
  // the ratchet. The file names carry the divisor, so the set can say whether it is complete.
  const totals = new Set(files.map((file) => Number(/-of-(\d+)\.json$/.exec(file)?.[1])));
  if (totals.size !== 1)
    throw new Error(`shards disagree on the divisor: ${[...totals].join(', ')}`);
  const [total] = [...totals];
  if (files.length !== total) {
    // Name the missing shard(s): a dead shard uploads no artifact, and "found 7" alone does not
    // say which slice of the corpus the merged number is silently missing.
    const present = new Set(
      files.map((file) => Number(/^results-(\d+)-of-\d+\.json$/.exec(basename(file))?.[1])),
    );
    const missing: number[] = [];
    for (let shard = 1; shard <= (total ?? 0); shard += 1)
      if (!present.has(shard)) missing.push(shard);
    throw new Error(
      `expected ${String(total)} shards under ${directory}, found ${String(files.length)} (missing shard(s): ${missing.join(', ')})`,
    );
  }
  const merged: Test262Result[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('results' in parsed))
      throw new Error(`${file}: expected a results array`);
    const { results } = parsed as { results: Test262Result[] };
    for (const result of results) {
      // A shard that ran the wrong `--shard=N/M` would otherwise be invisible: its tests merge in
      // twice and inflate the totals past the ratchet, which reads as a conformance win.
      if (seen.has(result.path)) throw new Error(`${result.path} appears in two shards`);
      seen.add(result.path);
      merged.push(result);
    }
  }
  process.stdout.write(
    `test262: merged ${String(files.length)} shard(s), ${String(merged.length)} results\n`,
  );
  return merged.sort((left, right) => left.path.localeCompare(right.path));
}

/** The published number, the failure sample, and the gates that decide the exit code.
 *
 * Shared verbatim by the whole-corpus run and by `--aggregate` so a sharded CI run is judged by
 * the same code as a local one — a second copy here would be a second definition of "conformance". */
function report(results: readonly Test262Result[]): void {
  const passed = results.filter((result) => result.verdict === 'passed').length;
  const failed = results.filter((result) => result.verdict === 'failed').length;
  const skipped = results.filter((result) => result.verdict === 'skipped').length;
  const skipCounts = new Map<string, number>();
  for (const result of results.filter((item) => item.verdict === 'skipped')) {
    const feature = /\(([^()]+)\)$/.exec(result.reason ?? '')?.[1];
    const category = feature ?? result.reason ?? 'unattributed skip';
    skipCounts.set(category, (skipCounts.get(category) ?? 0) + 1);
  }
  const details = [...skipCounts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([feature, count]) => `${feature}: ${String(count)}`)
    .join(', ');
  const rate = passed + failed === 0 ? 0 : (passed / (passed + failed)) * 100;
  process.stdout.write(
    `test262: ${String(passed)} passed, ${String(skipped)} skipped${details === '' ? '' : ` (${details})`}, ${String(failed)} failed — pass rate ${rate.toFixed(1)}%\n`,
  );
  const known = expectedFailures();
  const failures = results.filter((result) => result.verdict === 'failed');
  const unexplained = failures.filter((result) => !known.has(result.path));
  // Unexplained failures are REPORTED but do not by themselves fail the run: at this corpus size a
  // per-test expectation file cannot be the gate without becoming a five-thousand-line artifact
  // nobody reads, and an unreadable list explains nothing. The ratchet below is the gate — it is
  // what "monotonically tracked" means (plan.md §9 Task 6.1 step 7) — and this sample plus its
  // total is what keeps the failures visible rather than aggregate-only.
  for (const result of unexplained.slice(0, UNEXPLAINED_SAMPLE))
    process.stderr.write(`FAIL ${result.path}: ${(result.reason ?? '').split('\n')[0] ?? ''}\n`);
  if (unexplained.length > 0)
    process.stderr.write(
      `test262: ${String(unexplained.length)} failure(s) not in expected-fail.txt${unexplained.length > UNEXPLAINED_SAMPLE ? ` (showing ${String(UNEXPLAINED_SAMPLE)})` : ''}\n`,
    );
  const staleExpected = [...known.keys()].filter(
    (path) => results.find((result) => result.path === path)?.verdict !== 'failed',
  );
  for (const path of known.keys()) {
    const result = results.find((item) => item.path === path);
    if (result?.verdict === 'passed')
      process.stderr.write(`FAIL ${path}: unexpected PASS; remove it from expected-fail.txt\n`);
  }
  for (const path of staleExpected) {
    const result = results.find((item) => item.path === path);
    if (result === undefined)
      process.stderr.write(`FAIL ${path}: expected failure is absent from the pinned corpus\n`);
    else if (result.verdict !== 'passed')
      process.stderr.write(
        `FAIL ${path}: expected failure is now ${result.verdict}; update expected-fail.txt\n`,
      );
  }
  const ratchetFailures = ratchetCheck(passed, failed);
  for (const failure of ratchetFailures) process.stderr.write(`FAIL ${failure}\n`);
  if (
    staleExpected.length > 0 ||
    ratchetFailures.length > 0 ||
    [...known.keys()].some(
      (path) => results.find((item) => item.path === path)?.verdict === 'passed',
    )
  )
    process.exitCode = 1;
}

function wantPrettyResults(): boolean {
  return process.argv.includes('--pretty-results') || process.env['STATOR_TEST262_PRETTY'] === '1';
}

function wantWriteResults(): boolean {
  // Local scratch can skip the multi-MB results file; CI shards must still write (leave unset).
  return process.env['STATOR_TEST262_WRITE_RESULTS'] !== '0';
}

function writeResults(
  path: string,
  corpus: string | null,
  results: readonly Test262Result[],
): void {
  if (!wantWriteResults()) return;
  const payload = {
    corpus,
    commit: pinnedCommit(),
    passed: results.filter((result) => result.verdict === 'passed').length,
    failed: results.filter((result) => result.verdict === 'failed').length,
    skipped: results.filter((result) => result.verdict === 'skipped').length,
    results,
  };
  // Compact by default: pretty-printing ~53k results dominates local disk and CI artifact I/O.
  const body = wantPrettyResults() ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  writeFileSync(path, `${body}\n`, 'utf8');
}

async function main(): Promise<void> {
  const filter = parseFilter(process.argv);
  // `--aggregate <dir>` judges a sharded run and never touches the corpus: the shards did the work,
  // and this reads what they wrote. It is the only mode that can apply the gates (see loadShards).
  const aggregate = process.argv.indexOf('--aggregate');
  if (aggregate >= 0) {
    // A filtered slice is not the corpus: merging it here would publish fewer tests as if the
    // whole run had fewer failures. Loud error, never a silent slice (see header).
    if (filter !== undefined)
      throw new Error('--filter cannot be combined with --aggregate: aggregate the full shards');
    const directory = process.argv[aggregate + 1];
    if (directory === undefined) throw new Error('--aggregate requires a directory');
    const results = loadShards(directory);
    writeResults(RESULTS, corpusRoot(), results);
    report(results);
    return;
  }
  const root = corpusRoot();
  if (!existsSync(join(root, 'test'))) {
    if (filter !== undefined) {
      process.stdout.write(
        `test262 filter "${filter}": 0 passed, 0 skipped (corpus missing), 0 failed of 0 — filtered debug run, gates skipped\n`,
      );
      return;
    }
    process.stdout.write('test262: corpus missing — fetch with `pnpm run test262:fetch`\n');
    writeResults(RESULTS, null, []);
    process.stdout.write(
      'test262: 0 passed, 0 skipped (corpus missing), 0 failed — pass rate 0.0%\n',
    );
    return;
  }
  const shard = parseShard(process.argv);
  const all = testFiles(root);
  // The filter applies BEFORE sharding: `--shard` slices the filtered set, so the two compose and
  // the summary below names both selectors honestly.
  const filtered =
    filter === undefined ? all : all.filter((path) => relative(root, path).includes(filter));
  const paths =
    shard === undefined
      ? filtered
      : filtered.filter((_, index) => index % shard.total === shard.index - 1);
  // Phase 1: classify synchronously. Phase 2: pool only the tests that need compile/execute.
  // Merge back in input-path order so results.json stays deterministic (pool finishes out of order).
  const classified = paths.map((path) => classify(path, root));
  const runItems: {
    readonly index: number;
    readonly path: string;
    readonly metadata: Test262Frontmatter;
  }[] = [];
  for (let index = 0; index < classified.length; index += 1) {
    const item = classified[index];
    if (item === undefined) continue;
    if (item.action === 'run') runItems.push({ index, path: item.path, metadata: item.metadata });
  }
  const runResults = await pool(runItems, (item, slot) =>
    execute(item.path, root, item.metadata, slot),
  );
  // oxlint-disable-next-line unicorn/no-new-array -- preallocated; filled by index, never appended
  const results = new Array<Test262Result>(classified.length);
  for (let index = 0; index < classified.length; index += 1) {
    const item = classified[index];
    if (item === undefined) continue;
    if (item.action === 'skip') results[index] = item.result;
  }
  for (let i = 0; i < runItems.length; i += 1) {
    const item = runItems[i];
    const result = runResults[i];
    if (item === undefined || result === undefined) continue;
    results[item.index] = result;
  }
  if (filter !== undefined) {
    // A filtered run is a debug slice: honest counts of the slice, no gates, no result files, and
    // exit 0 — the same "a slice judges nothing" rule shards already follow (see below).
    const passed = results.filter((result) => result.verdict === 'passed').length;
    const failed = results.filter((result) => result.verdict === 'failed').length;
    const skipped = results.filter((result) => result.verdict === 'skipped').length;
    const where =
      shard === undefined
        ? `filter "${filter}"`
        : `shard ${String(shard.index)}/${String(shard.total)} filter "${filter}"`;
    process.stdout.write(
      `test262 ${where}: ${String(passed)} passed, ${String(skipped)} skipped, ${String(failed)} failed of ${String(paths.length)} — filtered debug run, gates skipped\n`,
    );
    return;
  }
  if (shard === undefined) {
    writeResults(RESULTS, root, results);
    report(results);
    return;
  }
  // A shard reports its slice and gates NOTHING — `--aggregate` is where the run is judged. A shard
  // that applied the ratchet to a quarter of the corpus would fail every time by construction.
  writeResults(shardResultsPath(shard.index, shard.total), root, results);
  const passed = results.filter((result) => result.verdict === 'passed').length;
  const failed = results.filter((result) => result.verdict === 'failed').length;
  const skipped = results.filter((result) => result.verdict === 'skipped').length;
  process.stdout.write(
    `test262 shard ${String(shard.index)}/${String(shard.total)}: ${String(passed)} passed, ${String(skipped)} skipped, ${String(failed)} failed of ${String(paths.length)}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
