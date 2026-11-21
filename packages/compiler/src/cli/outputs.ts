/* What `build` writes, and the two promises it makes about it (plan.md §9 Task 6.20): no output
 * overwrites an input or another output (STA0004), and a path the user cannot write is the
 * user's to fix (STA0019), never a compiler bug (STA4072). `build()` calls these rather than
 * `main.ts`, so the in-process callers (`statorc/api`, the Test262 runner) get the same answer. */

import { accessSync, constants, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BuildError } from '../support/diagnostics.ts';

/** A path with the words a diagnostic uses for it (`-o`, `--emit-header`, `the entry file`). */
export interface NamedPath {
  readonly role: string;
  readonly path: string;
}

/** Node's `error.code` (`ENOENT`, `EACCES`, …), when the thrown value carries one. */
export function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

/** The failures that describe the user's file system, not Stator: each names what to fix. */
const USER_WRITE_FAILURES: Readonly<Record<string, string>> = {
  ENOENT: 'the directory does not exist',
  ENOTDIR: 'a parent of it is not a directory',
  EISDIR: 'it is a directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EROFS: 'the file system is read-only',
  ENOSPC: 'no space left on the device',
};

/** The identity two spellings share when they name one file. An existing file is its inode, so
 * a symlink, a hard link or a case-folding file system cannot hide an alias. A file that does
 * not exist yet is its canonical directory plus its name: nothing can alias it but another
 * output, and two outputs spelled the same way resolve to the same key. */
function fileKey(path: string): string {
  const absolute = resolve(path);
  const stats = statSync(absolute, { bigint: true, throwIfNoEntry: false });
  if (stats !== undefined) {
    return `inode:${stats.dev}:${stats.ino}`;
  }
  try {
    return `path:${join(realpathSync.native(dirname(absolute)), basename(absolute))}`;
  } catch {
    return `path:${absolute}`;
  }
}

/** STA0004 when two outputs name one file, or an output names an input. Runs before anything is
 * written, so a refused build leaves every file as it was. */
export function refuseAliasedOutputs(
  outputs: readonly NamedPath[],
  inputs: readonly NamedPath[],
): void {
  const seen = new Map<string, NamedPath>();
  for (const output of outputs) {
    const key = fileKey(output.path);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw new BuildError(
        'STA0004',
        `${earlier.role} "${earlier.path}" and ${output.role} "${output.path}" name the same ` +
          'file — one output would overwrite the other',
      );
    }
    seen.set(key, output);
  }
  for (const input of inputs) {
    const output = seen.get(fileKey(input.path));
    if (output !== undefined) {
      throw new BuildError(
        'STA0004',
        `${output.role} "${output.path}" is ${input.role} "${input.path}" — refusing to ` +
          'overwrite an input',
      );
    }
  }
}

/** STA0019 before a tool (clang) writes `target`: its directory must exist and be writable, the
 * path must not be a directory, and a file already there must be writable too (ld64 opens it in
 * place, so a read-only one fails the link). Without this check, clang's own failure there would
 * read as a compiler bug (STA0009). */
export function requireWritable(target: NamedPath): void {
  try {
    const existing = statSync(target.path, { throwIfNoEntry: false });
    if (existing?.isDirectory() === true) {
      throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
    }
    if (existing !== undefined) {
      accessSync(target.path, constants.W_OK);
    }
    accessSync(dirname(resolve(target.path)), constants.W_OK);
  } catch (error) {
    throwWriteError(target, error);
  }
}

/** `writeFileSync`, with the user's file-system failures as STA0019. Text is written as UTF-8;
 * bytes (a `--emit=lib` archive) as they are. */
export function writeOutput(target: NamedPath, content: string | Uint8Array): void {
  try {
    writeFileSync(target.path, content, typeof content === 'string' ? 'utf8' : null);
  } catch (error) {
    throwWriteError(target, error);
  }
}

/** STA0019 for a failure the user can fix; anything else is rethrown unchanged, so a real bug
 * still reaches the CLI's STA4072. */
function throwWriteError(target: NamedPath, error: unknown): never {
  const code = errnoCode(error);
  const why = code === undefined ? undefined : USER_WRITE_FAILURES[code];
  if (code !== undefined && why !== undefined) {
    throw new BuildError(
      'STA0019',
      `cannot write ${target.role} "${target.path}": ${code} (${why})`,
    );
  }
  throw error;
}
