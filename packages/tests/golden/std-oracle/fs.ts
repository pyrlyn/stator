/* Node twin of packages/std/src/fs.ts. Node range-checks descriptors, lengths and positions
 * itself (ERR_OUT_OF_RANGE) and validates flag strings (ERR_INVALID_ARG_VALUE); std answers EBADF
 * and EINVAL, so the twin checks first and lets the OS answer the rest. */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { failure, quote, rethrow } from './failure.ts';

export class Stat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly mtimeMs: number;

  constructor(size: number, kind: number, mtimeMs: number) {
    this.size = size;
    this.isFile = kind === 1;
    this.isDirectory = kind === 2;
    this.mtimeMs = mtimeMs;
  }
}

/** std refuses a NUL in a path with EINVAL before the backing runs (Node: ERR_INVALID_ARG_VALUE). */
function guarded<T>(call: string, path: string, body: () => T): T {
  if (path.includes('\u0000')) {
    throw failure(call, quote(path), 'EINVAL');
  }
  return rethrow(call, quote(path), body);
}

export function readText(path: string): string {
  return guarded('std/fs.readText', path, () => readFileSync(path, 'utf8'));
}

export function writeText(path: string, text: string): void {
  guarded('std/fs.writeText', path, () => writeFileSync(path, text));
}

export function stat(path: string): Stat {
  const st = guarded('std/fs.stat', path, () => statSync(path));
  const kind = st.isFile() ? 1 : st.isDirectory() ? 2 : 0;
  return new Stat(st.size, kind, Math.trunc(st.mtimeMs));
}

export function mkdir(path: string): void {
  guarded('std/fs.mkdir', path, () => mkdirSync(path));
}

export function unlink(path: string): void {
  guarded('std/fs.unlink', path, () => unlinkSync(path));
}

export function rmdir(path: string): void {
  guarded('std/fs.rmdir', path, () => rmdirSync(path));
}

export function readBytes(path: string): Uint8Array {
  return guarded('std/fs.readBytes', path, () => new Uint8Array(readFileSync(path)));
}

export function exists(path: string): boolean {
  return existsSync(path);
}

export function realpath(path: string): string {
  return guarded('std/fs.realpath', path, () => realpathSync(path));
}

function timeMs(ms: number): boolean {
  return ms >= -8.64e15 && ms <= 8.64e15;
}

export function utimes(path: string, atimeMs: number, mtimeMs: number): void {
  if (!timeMs(atimeMs) || !timeMs(mtimeMs)) {
    throw failure('std/fs.utimes', quote(path), 'EINVAL');
  }
  guarded('std/fs.utimes', path, () => utimesSync(path, atimeMs / 1000, mtimeMs / 1000));
}

export function readdir(path: string): string[] {
  return guarded('std/fs.readdir', path, () => readdirSync(path));
}

const FLAGS = new Set([
  'r',
  'rs',
  'sr',
  'r+',
  'rs+',
  'sr+',
  'w',
  'wx',
  'xw',
  'w+',
  'wx+',
  'xw+',
  'a',
  'ax',
  'xa',
  'as',
  'sa',
  'a+',
  'ax+',
  'xa+',
  'as+',
  'sa+',
]);

export function open(path: string, flags: string = 'r'): number {
  if (!FLAGS.has(flags)) {
    throw failure('std/fs.open', quote(path), 'EINVAL');
  }
  return guarded('std/fs.open', path, () => openSync(path, flags, 0o666));
}

function descriptor(call: string, fd: number): number {
  if (!Number.isInteger(fd) || fd < 0 || fd > 2147483647) {
    throw failure(call, `${fd}`, 'EBADF');
  }
  return fd;
}

/** `-1` is the descriptor's own position (Node's `null`); anything else an integer 0..2^53. */
function position(call: string, fd: number, at: number): number | null {
  if (at === -1) {
    return null;
  }
  if (!Number.isInteger(at) || at < 0 || at > 2 ** 53) {
    throw failure(call, `${fd}`, 'EINVAL');
  }
  return at;
}

export function close(fd: number): void {
  const f = descriptor('std/fs.close', fd);
  rethrow('std/fs.close', `${fd}`, () => closeSync(f));
}

export function read(fd: number, length: number, at: number = -1): Uint8Array {
  const f = descriptor('std/fs.read', fd);
  const where = position('std/fs.read', fd, at);
  if (!Number.isInteger(length) || length < 0 || length > 2147483647) {
    throw failure('std/fs.read', `${fd}`, 'EINVAL');
  }
  const buffer = new Uint8Array(Math.min(length, 1 << 20));
  const got = rethrow('std/fs.read', `${fd}`, () => readSync(f, buffer, 0, buffer.length, where));
  return buffer.slice(0, got);
}

export function write(fd: number, data: Uint8Array, at: number = -1): number {
  const f = descriptor('std/fs.write', fd);
  const where = position('std/fs.write', fd, at);
  rethrow('std/fs.write', `${fd}`, () => {
    let done = writeSync(f, data, 0, data.length, where);
    while (done < data.length) {
      done += writeSync(f, data, done, data.length - done, where === null ? null : where + done);
    }
  });
  return data.length;
}
