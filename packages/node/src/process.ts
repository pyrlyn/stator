// `node:process` (plan.md §11c T11.6) — the `process` object `tsc` reads, over `std/process`,
// `std/env`, `std/os` and `std/io`. It is also the global `process` under `--node`: the frontend
// imports this module into every file that reads a free `process` (docs/MODES.md §6). The default
// export is an instance, not a namespace, because `process.exitCode = 1` assigns through an
// accessor. Gaps, each a subset or N2 limit:
// - `argv` has Node's single-executable shape: index 0 is `execPath`, index 1 is the program as
//   it was invoked, and the user's arguments start at 2. `execArgv` is empty;
// - `env` is a snapshot of the environment at startup that later writes update. A read sees every
//   write the program made, but the OS and child processes do not (no Proxy in the subset);
// - `memoryUsage()` reports `rss` only; the four heap numbers are 0 until `std/process` reads the
//   collector's heap;
// - `nextTick` callbacks run as promise jobs once the current job ends, so they interleave with
//   `then` callbacks in queue order where Node runs every tick before any promise job;
// - `stdout`/`stderr` answer `write(chunk)`, `fd`, `isTTY`, `columns` and `rows` only. `write`
//   takes one argument: an optional encoding would be an omitted method parameter, which this
//   calling convention cannot tell from a call with no receiver (docs/VALUE.md §4.16). No stream
//   events (`node:events` and `node:stream` are N2);
// - `browser` and `recordreplay` are not properties. In `js` mode a read of either is `undefined`,
//   which is what `tsc` tests. `on`, `once` and `emit` wait on `node:events`.

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
import { encodeText } from './internal/encoding.ts';

/** What `process.memoryUsage()` answers. The heap numbers stay 0 (see the header). */
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

  /** Writes `chunk` now and answers `true`: the write is synchronous, so nothing is queued.
   * A string with no NUL goes out as UTF-8 text; a string with a NUL, or a `Uint8Array`, goes
   * out as bytes, so a NUL is data rather than the C-string boundary. */
  write(chunk: string | Uint8Array): boolean {
    // `typeof === 'string'` is what narrows the union (the same shape as `std/hash` and
    // `node:fs`). The other arm is the `Uint8Array`.
    if (typeof chunk === 'string') {
      if (!chunk.includes('\u0000')) {
        writeText(this.fd, chunk);
      } else {
        writeBytes(this.fd, encodeText(chunk, 'utf8'));
      }
    } else {
      writeBytes(this.fd, chunk);
    }
    return true;
  }
}

/** The arguments in Node's single-executable shape (docs/MODES.md §6). */
function programArguments(): string[] {
  const out = [stdExecPath()];
  for (const arg of stdArgv()) {
    out.push(arg);
  }
  return out;
}

/** The environment as an object, read once. Later writes update the object, not the OS. */
function environment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of names()) {
    env[name] = get(name);
  }
  return env;
}

/** Runs `task(...args)` once the current job is done (see the gap above). Not generic, since the
 * subset cannot take a generic function as a value: in `ts` mode a callback with typed parameters
 * is passed as a closure that calls it. */
export function nextTick(task: (...args: unknown[]) => void, ...args: unknown[]): void {
  void Promise.resolve(0).then(() => task(...args));
}

/** The status an integer names: Node keeps its low 8 bits. */
function statusOf(code: number): number {
  return code & 0xff;
}

/** The process object: `import process from 'node:process'`, and the global `process`.
 * Built in the constructor rather than as `readonly x = x` field copies: that spelling is
 * `node:path`'s module object, and a second copy of it is a clone. */
export class Process {
  readonly argv: string[];
  readonly argv0: string;
  /** Empty: a Stator binary takes no runtime flags of its own. */
  readonly execArgv: string[];
  readonly execPath: string;
  readonly env: Record<string, string | undefined>;
  readonly platform: string;
  readonly arch: string;
  readonly pid: number;
  readonly ppid: number;
  readonly stdout: WriteStream;
  readonly stderr: WriteStream;
  readonly nextTick: (task: (...args: unknown[]) => void, ...args: unknown[]) => void;
  private code: number | undefined = undefined;

  constructor() {
    const args = programArguments();
    this.argv = args;
    this.argv0 = args[1] ?? '';
    this.execArgv = [];
    this.execPath = stdExecPath();
    this.env = environment();
    this.platform = stdPlatform();
    this.arch = stdArch();
    this.pid = stdPid();
    this.ppid = stdPpid();
    this.stdout = new WriteStream(1);
    this.stderr = new WriteStream(2);
    this.nextTick = nextTick;
  }

  /** `undefined` until the program sets it, as on Node. */
  get exitCode(): number | undefined {
    return this.code;
  }

  set exitCode(code: number | undefined) {
    this.code = code;
    setExitCode(code === undefined ? 0 : statusOf(code));
  }

  cwd(): string {
    return stdCwd();
  }

  memoryUsage(): MemoryUsage {
    return new MemoryUsage(stdMemoryUsage().rss);
  }

  /** Ends the process now with `code`. A missing argument is the function `exit` below: an
   * omitted method parameter is the same argc as a call with no receiver (docs/VALUE.md §4.16). */
  exit(code: number): never {
    stdExit(statusOf(code));
    throw new Error('unreachable: std/process.exit returned');
  }
}

const processObject = new Process();

// One pattern, not eleven `export const name = processObject.name` lines: those copies are one
// clone of each other (jscpd, identifier-insensitive). The bindings are the instance's own.
export const { argv, argv0, execArgv, execPath, env, platform, arch, pid, ppid, stdout, stderr } =
  processObject;

export function cwd(): string {
  return stdCwd();
}

export function memoryUsage(): MemoryUsage {
  return new MemoryUsage(stdMemoryUsage().rss);
}

/** Ends the process now with `code`, else `exitCode`, else 0. */
export function exit(code?: number): never {
  stdExit(statusOf(code ?? processObject.exitCode ?? 0));
  throw new Error('unreachable: std/process.exit returned');
}

export default processObject;
