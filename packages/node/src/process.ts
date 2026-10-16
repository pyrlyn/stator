// `node:process` (plan.md §11c T11.6) — the `process` object `tsc` reads, over `std/process`,
// `std/env`, `std/os` and `std/io`. It is also the global `process` under `--node`: the frontend
// imports this module into every file that reads a free `process` (docs/MODES.md §6). The default
// export is an instance, not a namespace, because `process.exitCode = 1` assigns through an
// accessor. Gaps, each a subset or N2 limit:
// - `env` is a snapshot of the environment at startup that later writes update: a read sees every
//   write the program made, but the OS and child processes do not (no Proxy in the subset);
// - `memoryUsage()` reports `rss` only; the four heap numbers are 0 until `std/process` reads the
//   collector's heap;
// - `nextTick` callbacks run as promise jobs once the current job ends, so they interleave with
//   `then` callbacks in queue order where Node runs every tick before any promise job;
// - `stdout`/`stderr` answer `write`, `fd`, `isTTY`, `columns` and `rows` only: no stream events
//   (`node:events` and `node:stream` are N2), and `write` ignores its callback;
// - `on`, `once`, `emit` and the rest of the `EventEmitter` surface wait on `node:events` (N2).

import { cwd as stdCwd, get, names } from 'std/env';
import { isatty, terminalSize, write as writeText, writeBytes } from 'std/io';
import { arch as stdArch, platform as stdPlatform } from 'std/os';
import {
  argv as stdArgv,
  execPath as stdExecPath,
  exit as stdExit,
  memoryUsage as stdMemoryUsage,
  pid as stdPid,
  ppid as stdPpid,
  setExitCode,
} from 'std/process';
import { encodeText, normalizeEncoding } from './internal/encoding.ts';

/** What `process.memoryUsage()` answers. */
export class MemoryUsage {
  readonly rss: number;
  readonly heapTotal: number = 0;
  readonly heapUsed: number = 0;
  readonly external: number = 0;
  readonly arrayBuffers: number = 0;

  constructor(rss: number) {
    this.rss = rss;
  }
}

/** `process.stdout` and `process.stderr`: a descriptor that takes writes. */
export class WriteStream {
  readonly fd: number;

  constructor(fd: number) {
    this.fd = fd;
  }

  /** `true` on a terminal; Node leaves the property `undefined` otherwise. */
  get isTTY(): true | undefined {
    return isatty(this.fd) ? true : undefined;
  }

  get columns(): number | undefined {
    return isatty(this.fd) ? terminalSize(this.fd).columns : undefined;
  }

  get rows(): number | undefined {
    return isatty(this.fd) ? terminalSize(this.fd).rows : undefined;
  }

  /** Writes `chunk` now and answers `true`: the write is synchronous, so nothing is queued. */
  write(chunk: string | Uint8Array, encoding?: string): boolean {
    if (typeof chunk !== 'string') {
      writeBytes(this.fd, chunk);
    } else if (encoding === undefined && !chunk.includes('\u0000')) {
      writeText(this.fd, chunk);
    } else {
      writeBytes(this.fd, encodeText(chunk, normalizeEncoding(encoding ?? 'utf8') ?? 'utf8'));
    }
    return true;
  }
}

/** The environment as an object, read once. */
function environment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of names()) {
    env[name] = get(name);
  }
  return env;
}

/** Node's single-executable shape (docs/MODES.md §6): the executable's absolute path, then the
 * program as it was invoked, then the user's arguments from index 2. */
export const argv: string[] = [stdExecPath(), ...stdArgv()];
export const argv0: string = argv[1] ?? '';
/** Empty: a Stator binary takes no runtime flags of its own, as a single-executable app does. */
export const execArgv: string[] = [];
export const execPath: string = stdExecPath();
export const env: Record<string, string | undefined> = environment();
export const platform: string = stdPlatform();
export const arch: string = stdArch();
export const pid: number = stdPid();
export const ppid: number = stdPpid();
export const stdout: WriteStream = new WriteStream(1);
export const stderr: WriteStream = new WriteStream(2);

export function cwd(): string {
  return stdCwd();
}

export function memoryUsage(): MemoryUsage {
  return new MemoryUsage(stdMemoryUsage().rss);
}

/** Runs `task(...args)` once the current job is done (see the gap above). Not generic, since the
 * subset cannot take a generic function as a value: in `ts` mode a callback with typed parameters
 * is passed as a closure that calls it. */
export function nextTick(task: (...args: unknown[]) => void, ...args: unknown[]): void {
  void Promise.resolve(0).then(() => task(...args));
}

/** The status an integer names: Node keeps its low 8 bits. */
function status(code: number): number {
  return code & 0xff;
}

/** The process object: `import process from 'node:process'`, and the global `process`. */
export class Process {
  readonly argv: string[] = argv;
  readonly argv0: string = argv0;
  readonly execArgv: string[] = execArgv;
  readonly execPath: string = execPath;
  readonly env: Record<string, string | undefined> = env;
  readonly platform: string = platform;
  readonly arch: string = arch;
  readonly pid: number = pid;
  readonly ppid: number = ppid;
  readonly stdout: WriteStream = stdout;
  readonly stderr: WriteStream = stderr;
  readonly nextTick = nextTick;
  private code: number | undefined = undefined;

  /** `undefined` until the program sets it, as on Node. */
  get exitCode(): number | undefined {
    return this.code;
  }

  set exitCode(code: number | undefined) {
    this.code = code;
    setExitCode(code === undefined ? 0 : status(code));
  }

  cwd(): string {
    return cwd();
  }

  memoryUsage(): MemoryUsage {
    return memoryUsage();
  }

  /** Ends the process now with `code`, else `exitCode`, else 0. */
  exit(code?: number): never {
    stdExit(status(code ?? this.code ?? 0));
    throw new Error('unreachable: std/process.exit returned');
  }
}

const process = new Process();

export function exit(code?: number): never {
  return process.exit(code);
}

export default process;
