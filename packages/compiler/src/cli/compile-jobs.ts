/** `STATOR_COMPILE_JOBS` (plan.md §11b T10.3).
 *
 * `1` is one translation unit and one clang invocation — the path every build
 * took before this knob, so emitted C at jobs=1 stays byte-identical.
 * Above 1, file-scope functions are compiled as separate units that share one
 * header of external declarations. The default (unset) is the host's
 * parallelism, but a small program stays one unit: process startup costs more
 * than it returns until the generated C is large enough (the thresholds below).
 * An explicit value above 1 always splits when there are at least two functions,
 * which is how CI smokes the parallel path on a small fixture.
 */

import { availableParallelism } from 'node:os';

/** Unset `STATOR_COMPILE_JOBS` splits only at or above both of these.
 * Tuned against the T10.3 fixtures in plan-notes 361: a 31KB program did not
 * get faster, and the clang-heavy program that did is well above both. */
export const PARALLEL_MIN_FUNCTIONS = 8;
export const PARALLEL_MIN_CHARS = 40_000;

const JOBS_TEXT = /^(0|[1-9][0-9]*)$/;

export type ResolvedJobs =
  | { readonly ok: true; readonly jobs: number; readonly explicit: boolean }
  | { readonly ok: false; readonly message: string };

/** `override` is the in-process test seam. The CLI leaves it unset and the
 * environment variable decides. */
export function resolveCompileJobs(
  envValue: string | undefined,
  override: number | undefined,
): ResolvedJobs {
  if (override !== undefined) {
    return checkedJobs(override, String(override), 'compile jobs');
  }
  const raw = envValue?.trim();
  if (raw === undefined || raw === '') {
    return { ok: true, jobs: availableParallelism(), explicit: false };
  }
  return checkedJobs(Number(raw), raw, 'the environment variable STATOR_COMPILE_JOBS');
}

function checkedJobs(jobs: number, raw: string, where: string): ResolvedJobs {
  if (!JOBS_TEXT.test(raw) || !Number.isSafeInteger(jobs) || jobs < 1) {
    return {
      ok: false,
      message: `unknown compile jobs "${raw}" in ${where} (expected an integer >= 1)`,
    };
  }
  return { ok: true, jobs, explicit: true };
}

export interface TranslationUnit {
  readonly name: string;
  readonly source: string;
}

export interface PartitionedC {
  readonly headerName: string;
  readonly header: string;
  readonly units: readonly TranslationUnit[];
}

const HEADER_NAME = 'stator_units.h';

/** True when this build should compile more than one translation unit. */
export function shouldSplitTranslationUnit(c: string, jobs: number, explicit: boolean): boolean {
  if (jobs < 2) {
    return false;
  }
  const functions = countTopLevelFunctions(c);
  if (functions < 2) {
    return false;
  }
  if (explicit) {
    return true;
  }
  return functions >= PARALLEL_MIN_FUNCTIONS && c.length >= PARALLEL_MIN_CHARS;
}

/** Split emitted C into a shared data unit plus up to `jobs` function units.
 * Requires `jobs >= 2` and at least two top-level functions — the caller
 * checked `shouldSplitTranslationUnit`. A function that never closes is an
 * emitter bug, not a reason to link a partial program. */
export function partitionTranslationUnit(c: string, jobs: number): PartitionedC {
  const walked = walkEmittedC(c);
  if (jobs < 2 || walked.functions.length < 2) {
    throw new Error('partitionTranslationUnit: nothing to split');
  }
  const headerLines: string[] = ['#ifndef STATOR_UNITS_H', '#define STATOR_UNITS_H', ''];
  const sharedLines: string[] = [`#include "${HEADER_NAME}"`, ''];
  for (const line of walked.preamble) {
    const kind = classifyPreamble(line);
    switch (kind) {
      case 'blank':
        break;
      case 'include':
        headerLines.push(line);
        break;
      case 'globals': {
        const slots = /^JSRT_GLOBALS\((\d+)\);$/.exec(line)?.[1];
        if (slots === undefined) {
          throw new Error('JSRT_GLOBALS line did not name a slot count');
        }
        // The macro defines these `static`. Across units they have to be one
        // object: `JSRT_GLOBAL` in a function unit reads the array `main` fills.
        headerLines.push('extern jsrt_value _jsrt_globals[];');
        headerLines.push('extern JSRTFrame _jsrt_global_frame;');
        sharedLines.push(`jsrt_value _jsrt_globals[${slots}];`);
        sharedLines.push('JSRTFrame _jsrt_global_frame;');
        break;
      }
      case 'prototype':
        headerLines.push(line.startsWith('static ') ? line.slice('static '.length) : line);
        break;
      case 'data': {
        const bare = line.startsWith('static ') ? line.slice('static '.length) : line;
        headerLines.push(asExtern(bare));
        sharedLines.push(bare);
        break;
      }
      case 'other':
        sharedLines.push(line);
        break;
      default: {
        const _exhaustive: never = kind;
        throw new Error(_exhaustive);
      }
    }
  }
  const bucketCount = Math.min(jobs, walked.functions.length);
  const units: TranslationUnit[] = [
    { name: 'stator_shared.c', source: `${sharedLines.join('\n')}\n` },
  ];
  for (const [index, lines] of bucketFunctions(walked.functions, bucketCount).entries()) {
    units.push({
      name: `stator_unit_${String(index)}.c`,
      source: `#include "${HEADER_NAME}"\n\n${lines.join('\n')}\n`,
    });
  }
  headerLines.push('', '#endif /* STATOR_UNITS_H */');
  return { headerName: HEADER_NAME, header: `${headerLines.join('\n')}\n`, units };
}

export function countTopLevelFunctions(c: string): number {
  return walkEmittedC(c).functions.length;
}

interface WalkedC {
  readonly preamble: readonly string[];
  readonly functions: readonly (readonly string[])[];
}

/** Every generated function opens at column zero and its closing `}` is the
 * only unindented brace. That is the emitter's layout, not a C parser. */
function walkEmittedC(c: string): WalkedC {
  const preamble: string[] = [];
  const functions: string[][] = [];
  let open: string[] | null = null;
  for (const line of c.split('\n')) {
    if (open === null) {
      if (isFunctionOpen(line)) {
        open = [line];
      } else {
        preamble.push(line);
      }
      continue;
    }
    open.push(line);
    if (line === '}') {
      functions.push(open);
      open = null;
    }
  }
  if (open !== null) {
    throw new Error('emitted C has a function that never closed');
  }
  return { preamble, functions };
}

function isFunctionOpen(line: string): boolean {
  return (
    line.endsWith(' {') &&
    line.includes('(') &&
    !line.startsWith('#') &&
    !line.startsWith('static const ')
  );
}

type PreambleKind = 'blank' | 'include' | 'globals' | 'prototype' | 'data' | 'other';

function classifyPreamble(line: string): PreambleKind {
  if (line.trim() === '') {
    return 'blank';
  }
  if (line.startsWith('#include ')) {
    return 'include';
  }
  if (/^JSRT_GLOBALS\(\d+\);$/.test(line)) {
    return 'globals';
  }
  if (line.startsWith('static ') && isPrototype(line)) {
    return 'prototype';
  }
  if (line.startsWith('static ')) {
    return 'data';
  }
  if (isPrototype(line)) {
    return 'prototype';
  }
  return 'other';
}

function isPrototype(line: string): boolean {
  return line.endsWith(';') && line.includes('(') && initializerAt(line) === -1;
}

/** Index of the ` = ` that starts a file-scope initializer, ignoring one
 * inside a string. `-1` when the line is a declaration. */
function initializerAt(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length - 2; i++) {
    const ch = line[i];
    if (ch === '\\' && quoted) {
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && line.startsWith(' = ', i)) {
      return i;
    }
  }
  return -1;
}

function asExtern(bare: string): string {
  const at = initializerAt(bare);
  const head = (at === -1 ? bare : bare.slice(0, at)).trimEnd();
  const decl = head.endsWith(';') ? head : `${head};`;
  return decl.startsWith('extern ') ? decl : `extern ${decl}`;
}

/** Largest functions first, each into the lightest bucket, so `jobs` clang
 * processes get about the same amount of C. Empty buckets are dropped. */
function bucketFunctions(functions: readonly (readonly string[])[], buckets: number): string[][] {
  const groups: string[][] = Array.from({ length: buckets }, () => []);
  const weight: number[] = Array.from({ length: buckets }, () => 0);
  const ranked = functions
    .map((lines, index) => ({ lines, index, weight: lines.length }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const fn of ranked) {
    let best = 0;
    for (let i = 1; i < buckets; i++) {
      const here = weight[i];
      const lightest = weight[best];
      if (here !== undefined && lightest !== undefined && here < lightest) {
        best = i;
      }
    }
    const group = groups[best];
    const current = weight[best];
    if (group === undefined || current === undefined) {
      continue;
    }
    if (group.length > 0) {
      group.push('');
    }
    group.push(...publishFunction(fn.lines));
    weight[best] = current + fn.weight;
  }
  return groups.filter((group) => group.length > 0);
}

/** File-scope `static` hides the function from every other unit. The first
 * real line is the signature; a body-local `static` stays. */
function publishFunction(lines: readonly string[]): string[] {
  let stripped = false;
  return lines.map((line) => {
    if (stripped || line.startsWith('#line ') || line === '') {
      return line;
    }
    stripped = true;
    return line.startsWith('static ') ? line.slice('static '.length) : line;
  });
}
