// What `node:fs` exports (`../fs.ts` re-exports it, and its default export is this module's
// namespace, as Node's is its exports object): the synchronous subset `tsc` calls, plus
// `rmdirSync` (plan.md §11c T11.6, docs/NODE.md), over `std/fs`. Failures throw Node's system
// error (`system-error.ts`): the same code,
// syscall, path and message the pinned Node v26.7.0 gives. Gaps, each a subset or `std` limit:
// - a path is a `string` (no `Buffer` or `URL`), and a flag is a string (no `O_*` number);
// - `readdirSync` answers names in byte order, where Node answers the OS's order;
// - a `Dirent` follows symbolic links, so `isSymbolicLink()` is always false;
// - `Stats` carries `size`, `mtimeMs` and `mtime` only, in whole milliseconds;
// - `watch`, `watchFile` and `unwatchFile` need the event loop (N2) and have not landed.

import { cwd } from 'std/env';
import {
  close,
  exists,
  mkdir,
  open,
  readBytes,
  readdir,
  realpath,
  rmdir,
  stat,
  unlink,
  utimes,
  write,
} from 'std/fs';
import { Buffer } from './buffer.ts';
import { decodeBytes, encodeText, invalidEncoding, normalizeEncoding } from './encoding.ts';
import { stdCode, SystemError } from './system-error.ts';
import { basename, dirname, join, resolve } from '../path.ts';

/** The error Node throws for a failed `syscall` on `path`, from the `std` failure behind it. */
function failure(error: unknown, syscall: string, path: string | undefined): SystemError {
  return new SystemError(stdCode(error), syscall, path);
}

/** The canonical encoding an option names, or `undefined` for none (bytes). */
function encodingOf(options: string | EncodingOptions | undefined): string | undefined {
  const named = typeof options === 'string' ? options : options?.encoding;
  if (named === undefined || named === null) return undefined;
  const encoding = normalizeEncoding(named);
  if (encoding === undefined) throw invalidEncoding(named);
  return encoding;
}

export interface EncodingOptions {
  readonly encoding?: string | null;
  readonly flag?: string;
}

export interface WriteFileOptions {
  readonly encoding?: string | null;
  readonly flag?: string;
  readonly mode?: number;
}

export interface StatOptions {
  readonly throwIfNoEntry?: boolean;
}

export interface MkdirOptions {
  readonly recursive?: boolean;
  readonly mode?: number;
}

export interface ReaddirOptions {
  readonly encoding?: string | null;
  readonly withFileTypes?: boolean;
}

/** What `statSync` answers (symbolic links followed). */
export class Stats {
  readonly size: number;
  readonly mtimeMs: number;
  private readonly kind: number;

  constructor(size: number, kind: number, mtimeMs: number) {
    this.size = size;
    this.kind = kind;
    this.mtimeMs = mtimeMs;
  }

  get mtime(): Date {
    return new Date(this.mtimeMs);
  }

  isFile(): boolean {
    return this.kind === 1;
  }

  isDirectory(): boolean {
    return this.kind === 2;
  }

  isSymbolicLink(): boolean {
    return false;
  }
}

/** One directory entry, as `readdirSync(path, { withFileTypes: true })` answers it. */
export class Dirent {
  readonly name: string;
  readonly parentPath: string;
  private readonly kind: number;

  constructor(name: string, parentPath: string, kind: number) {
    this.name = name;
    this.parentPath = parentPath;
    this.kind = kind;
  }

  isFile(): boolean {
    return this.kind === 1;
  }

  isDirectory(): boolean {
    return this.kind === 2;
  }

  isSymbolicLink(): boolean {
    return false;
  }
}

/** 1 for a file, 2 for a directory, 0 for anything else or a path that cannot be read. */
function kindOf(path: string): number {
  try {
    const found = stat(path);
    return found.isFile ? 1 : found.isDirectory ? 2 : 0;
  } catch {
    return 0;
  }
}

export function existsSync(path: string): boolean {
  return exists(path);
}

export function readFileSync(path: string): Buffer;
export function readFileSync(path: string, options: string | EncodingOptions): string;
export function readFileSync(path: string, options?: string | EncodingOptions): string | Buffer {
  const encoding = encodingOf(options);
  let bytes: Uint8Array;
  try {
    bytes = readBytes(path);
  } catch (error) {
    const code = stdCode(error);
    throw code === 'EISDIR'
      ? new SystemError(code, 'read', undefined)
      : new SystemError(code, 'open', path);
  }
  return encoding === undefined ? Buffer.copyBytesFrom(bytes) : decodeBytes(bytes, encoding);
}

export function writeFileSync(
  path: string,
  data: string | Uint8Array,
  options?: string | WriteFileOptions,
): void {
  const bytes = typeof data === 'string' ? encodeText(data, encodingOf(options) ?? 'utf8') : data;
  const flag = typeof options === 'string' ? undefined : options?.flag;
  const fd = openSync(path, flag ?? 'w');
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

export function statSync(path: string): Stats;
export function statSync(path: string, options: StatOptions): Stats | undefined;
export function statSync(path: string, options?: StatOptions): Stats | undefined {
  try {
    const found = stat(path);
    return new Stats(found.size, found.isFile ? 1 : found.isDirectory ? 2 : 0, found.mtimeMs);
  } catch (error) {
    const code = stdCode(error);
    if (options?.throwIfNoEntry === false && (code === 'ENOENT' || code === 'ENOTDIR')) {
      return undefined;
    }
    throw new SystemError(code, 'stat', path);
  }
}

/** Creates `path`; with `recursive`, its missing parents too, answering the first directory it
 * created (`undefined` when there was none). */
export function mkdirSync(path: string, options?: number | MkdirOptions): string | undefined {
  const recursive = typeof options === 'number' ? false : options?.recursive === true;
  if (!recursive) {
    try {
      mkdir(path);
    } catch (error) {
      throw failure(error, 'mkdir', path);
    }
    return undefined;
  }
  const missing: string[] = [];
  let at = path;
  while (!exists(at)) {
    missing.push(at);
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
  if (missing.length === 0 && kindOf(path) !== 2) {
    throw new SystemError('EEXIST', 'mkdir', path);
  }
  for (let i = missing.length - 1; i >= 0; i--) {
    const dir = missing[i] ?? path;
    try {
      mkdir(dir);
    } catch (error) {
      throw failure(error, 'mkdir', path);
    }
  }
  return missing[missing.length - 1];
}

export function unlinkSync(path: string): void {
  try {
    unlink(path);
  } catch (error) {
    throw failure(error, 'unlink', path);
  }
}

export function readdirSync(path: string, options: { readonly withFileTypes: true }): Dirent[];
export function readdirSync(path: string, options?: string | ReaddirOptions): string[];
export function readdirSync(path: string, options?: string | ReaddirOptions): string[] | Dirent[] {
  let names: string[];
  try {
    names = readdir(path);
  } catch (error) {
    throw failure(error, 'scandir', path);
  }
  if (typeof options === 'string' || options?.withFileTypes !== true) return names;
  return names.map((name: string): Dirent => new Dirent(name, path, kindOf(join(path, name))));
}

/** Removes an empty directory. */
export function rmdirSync(path: string): void {
  try {
    rmdir(path);
  } catch (error) {
    throw failure(error, 'rmdir', path);
  }
}

/** The canonical path. Node walks the path with `lstat`, so a missing component fails there,
 * named by its absolute path. */
export function realpathSync(path: string): string {
  try {
    return realpath(path);
  } catch (error) {
    // Node names the first missing component, spelled from its parent's canonical path (on
    // macOS `/tmp/x` fails as `/private/tmp/x`).
    let missing = resolve(cwd(), path);
    let parent = dirname(missing);
    while (!exists(parent) && parent !== missing) {
      missing = parent;
      parent = dirname(parent);
    }
    const spelled = exists(parent) ? join(realpath(parent), basename(missing)) : missing;
    throw failure(error, 'lstat', spelled);
  }
}

export function openSync(path: string, flags: string = 'r', mode?: number): number {
  if (mode !== undefined && mode < 0) {
    throw new SystemError('EINVAL', 'open', path);
  }
  try {
    return open(path, flags);
  } catch (error) {
    throw failure(error, 'open', path);
  }
}

export function closeSync(fd: number): void {
  try {
    close(fd);
  } catch (error) {
    throw failure(error, 'close', undefined);
  }
}

/** Writes `data` and answers the byte count: a string encoded (`utf8` by default) at
 * `position`, or `length` bytes of a byte array from `offset`. A `null` or absent position
 * writes at the descriptor's own, which advances. */
export function writeSync(
  fd: number,
  data: string | Uint8Array,
  offsetOrPosition?: number | null,
  lengthOrEncoding?: number | string | null,
  position?: number | null,
): number {
  let bytes: Uint8Array;
  let at: number | null | undefined;
  if (typeof data === 'string') {
    const named = typeof lengthOrEncoding === 'string' ? lengthOrEncoding : undefined;
    bytes = encodeText(data, encodingOf(named) ?? 'utf8');
    at = offsetOrPosition;
  } else {
    const offset = offsetOrPosition ?? 0;
    const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : data.length - offset;
    bytes = data.subarray(offset, offset + length);
    at = position;
  }
  try {
    return write(fd, bytes, at ?? -1);
  } catch (error) {
    throw failure(error, 'write', undefined);
  }
}

function dateMs(time: Date): number {
  return time.getTime();
}

/** Seconds since the epoch (a number, as Node takes it) or a `Date`, in milliseconds. The `Date`
 * goes through a `Date` parameter: a member call on a `Date` narrowed out of `number | Date` is a
 * dynamic call today, and it panics (STA2006) where the typed call does not. */
function epochMs(time: number | Date): number {
  return typeof time === 'number' ? time * 1000 : dateMs(time);
}

export function utimesSync(path: string, atime: number | Date, mtime: number | Date): void {
  try {
    utimes(path, epochMs(atime), epochMs(mtime));
  } catch (error) {
    throw failure(error, 'utime', path);
  }
}
