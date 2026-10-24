import { submit } from './internal/thread.ts';
// Paths resolve against the process working directory. Promise twins submit synchronous
// operations to reusable OS workers so the main microtask drain stays responsive.

import { jsrtStdResult, type CString } from './native/core.js';
import {
  jsrtStdFsClose,
  jsrtStdFsExists,
  jsrtStdFsMkdir,
  jsrtStdFsOpen,
  jsrtStdFsRead,
  jsrtStdFsReadBytes,
  jsrtStdFsReadBytesTake,
  jsrtStdFsReaddir,
  jsrtStdFsReaddirCount,
  jsrtStdFsReaddirName,
  jsrtStdFsReadText,
  jsrtStdFsRealpath,
  jsrtStdFsRmdir,
  jsrtStdFsStat,
  jsrtStdFsStatKind,
  jsrtStdFsStatMtimeMs,
  jsrtStdFsStatSize,
  jsrtStdFsUnlink,
  jsrtStdFsUtimes,
  jsrtStdFsWrite,
  jsrtStdFsWriteText,
} from './native/fs.js';
import { __stdFailure, __stdQuote } from './internal/error.ts';
import { __stdReadAnswer, __stdReadView } from './internal/read.ts';
import { __stdStrings } from './internal/strings.ts';

/** What `stat` reports about a path (symlinks followed). A class rather than an interface: a
 * class instance has a fixed layout and compiles static, where an object literal typed by an
 * interface is a dynamic object (docs/SUBSET.md). Programs get one from `stat`, never `new`. */
export class Stat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /** Last modification, whole milliseconds since the Unix epoch. */
  readonly mtimeMs: number;

  constructor(size: number, kind: number, mtimeMs: number) {
    this.size = size;
    this.isFile = kind === 1;
    this.isDirectory = kind === 2;
    this.mtimeMs = mtimeMs;
  }
}

/** The file's contents decoded as UTF-8 (an invalid sequence becomes U+FFFD). A NUL byte ends the
 * text: the C-string boundary truncates there (docs/FFI.md §3); `readBytes` carries every byte. */
export function readText(path: string): string {
  if (jsrtStdFsReadText(path as CString) !== 0) {
    throw __stdFailure('std/fs.readText', __stdQuote(path));
  }
  return jsrtStdResult();
}

/** Creates or truncates the file and writes `text` as UTF-8. */
export function writeText(path: string, text: string): void {
  if (jsrtStdFsWriteText(path as CString, text as CString) !== 0) {
    throw __stdFailure('std/fs.writeText', __stdQuote(path));
  }
}

export function stat(path: string): Stat {
  if (jsrtStdFsStat(path as CString) !== 0) {
    throw __stdFailure('std/fs.stat', __stdQuote(path));
  }
  return new Stat(jsrtStdFsStatSize(), jsrtStdFsStatKind(), jsrtStdFsStatMtimeMs());
}

/** Creates one directory; its parent must exist, and an existing path is EEXIST. */
export function mkdir(path: string): void {
  if (jsrtStdFsMkdir(path as CString) !== 0) {
    throw __stdFailure('std/fs.mkdir', __stdQuote(path));
  }
}

/** Removes a file (not a directory). */
export function unlink(path: string): void {
  if (jsrtStdFsUnlink(path as CString) !== 0) {
    throw __stdFailure('std/fs.unlink', __stdQuote(path));
  }
}

/** Removes an empty directory; a non-empty one is ENOTEMPTY. */
export function rmdir(path: string): void {
  if (jsrtStdFsRmdir(path as CString) !== 0) {
    throw __stdFailure('std/fs.rmdir', __stdQuote(path));
  }
}

/** The file's contents, every byte. */
export function readBytes(path: string): Uint8Array {
  // The size is known only once the file is read, so the backing parks the bytes and answers
  // their count; the second call copies them into a view of that size and frees them.
  const count = jsrtStdFsReadBytes(path as CString);
  if (count < 0) {
    throw __stdFailure('std/fs.readBytes', __stdQuote(path));
  }
  const out = new Uint8Array(count);
  jsrtStdFsReadBytesTake(out);
  return out;
}

/** Whether `path` names anything (symbolic links followed); false, never an error, otherwise. */
export function exists(path: string): boolean {
  return jsrtStdFsExists(path as CString) === 1;
}

/** The canonical absolute path: symbolic links, `.` and `..` resolved. The path must exist. */
export function realpath(path: string): string {
  if (jsrtStdFsRealpath(path as CString) !== 0) {
    throw __stdFailure('std/fs.realpath', __stdQuote(path));
  }
  return jsrtStdResult();
}

/** Sets the access and modification times, in milliseconds since the Unix epoch (Node's
 * `utimesSync` takes seconds). A time outside a `Date`'s range is EINVAL. */
export function utimes(path: string, atimeMs: number, mtimeMs: number): void {
  if (jsrtStdFsUtimes(path as CString, atimeMs, mtimeMs) !== 0) {
    throw __stdFailure('std/fs.utimes', __stdQuote(path));
  }
}

/** The directory's entry names, without `.` and `..`, in byte order. */
export function readdir(path: string): string[] {
  if (jsrtStdFsReaddir(path as CString) !== 0) {
    throw __stdFailure('std/fs.readdir', __stdQuote(path));
  }
  return __stdStrings(jsrtStdFsReaddirCount(), (i: number): string => jsrtStdFsReaddirName(i));
}

/** Opens `path` and answers its descriptor, which the program owns until `close` — nothing
 * closes it for you. `flags` is one of Node's flag strings (`'r'`, `'r+'`, `'w'`, `'wx'`, `'w+'`,
 * `'a'`, `'a+'`, …; any other is EINVAL); a created file gets mode 0666 before the umask. */
export function open(path: string, flags: string = 'r'): number {
  const fd = jsrtStdFsOpen(path as CString, flags as CString);
  if (fd < 0) {
    throw __stdFailure('std/fs.open', __stdQuote(path));
  }
  return fd;
}

/** Closes a descriptor `open` answered; closing one twice is EBADF. */
export function close(fd: number): void {
  if (jsrtStdFsClose(fd) !== 0) {
    throw __stdFailure('std/fs.close', `${fd}`);
  }
}

/** One read of at most `length` bytes (and at most 1 MiB) at `position`, or at the descriptor's
 * own position, which then advances, when `position` is -1. An empty answer is end of file. */
export function read(fd: number, length: number, position: number = -1): Uint8Array {
  const into = __stdReadView(length);
  const count = jsrtStdFsRead(fd, length, position, into);
  if (count < 0) {
    throw __stdFailure('std/fs.read', `${fd}`);
  }
  return __stdReadAnswer(into, count);
}

/** Writes all of `data` at `position`, or at the descriptor's own position when it is -1, and
 * answers the byte count. */
export function write(fd: number, data: Uint8Array, position: number = -1): number {
  if (jsrtStdFsWrite(fd, position, data) !== 0) {
    throw __stdFailure('std/fs.write', `${fd}`);
  }
  return data.length;
}

/** Captures a path before starting a worker; the function itself stays ordinary TypeScript. */
function pathTask<T>(operation: (path: string) => T): (path: string) => Promise<T> {
  return (path: string) => submit(() => operation(path));
}

export const readTextAsync = pathTask(readText);
export const statAsync = pathTask(stat);
export const mkdirAsync = pathTask(mkdir);
export const unlinkAsync = pathTask(unlink);
export const rmdirAsync = pathTask(rmdir);

export function writeTextAsync(path: string, text: string): Promise<void> {
  return submit(() => writeText(path, text));
}
