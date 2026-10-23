// `node:process` (plan.md §11c T11.6) — the `process` object `tsc` reads, over `std/process`,
// `std/env` and `std/os`. The default export is an instance, not a namespace, because
// `process.exitCode = 1` assigns through an accessor. Gaps, each a subset or N2 limit:
// - `argv` has Node's single-executable shape: index 0 is `execPath`, index 1 is the program as
//   it was invoked, and the user's arguments start at 2. `execArgv` is empty;
// - `env` is a snapshot of the environment at startup that later writes update. A read sees every
//   write the program made, but the OS and child processes do not (no Proxy in the subset);
// - `memoryUsage()` reports `rss` only; the four heap numbers are 0 until `std/process` reads the
//   collector's heap;
// - `hrtime()` answers `[seconds, nanoseconds]` as `number[]` (the HIR has no tuple). The
//   `hrtime.bigint` and `hrtime(previous)` forms need a function with properties (not-yet);
// - `stdout`/`stderr`, `nextTick`, `title` and the rest of the 68-member surface wait on their
//   own slices (docs/NODE.md).

import { cwd as stdCwd, get, names } from 'std/env';
import { arch as stdArch, platform as stdPlatform } from 'std/os';
import {
  argv as stdArgv,
  execPath as stdExecPath,
  exit as stdExit,
  hrtimeNs,
  memoryUsage as stdMemoryUsage,
  pid as stdPid,
  ppid as stdPpid,
  setExitCode,
} from 'std/process';

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

/** The arguments in Node's single-executable shape (docs/MODES.md §6). */
function programArguments(): string[] {
  const out = [''].slice(1);
  out.push(stdExecPath());
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

/** The status an integer names: Node keeps its low 8 bits. */
function statusOf(code: number): number {
  return code & 0xff;
}

/** `[seconds, nanoseconds]` from a monotonic nanosecond reading. Only differences mean
 * anything; the two halves are what Node's `process.hrtime()` answers. */
function hrtimePair(): number[] {
  const ns = hrtimeNs();
  return [Math.floor(ns / 1e9), ns % 1e9];
}

/** The process object: `import process from 'node:process'`. */
export class Process {
  readonly argv: string[];
  readonly execPath: string;
  readonly env: Record<string, string | undefined>;
  readonly platform: string;
  readonly arch: string;
  readonly pid: number;
  readonly ppid: number;
  private code: number | undefined = undefined;

  constructor() {
    this.argv = programArguments();
    this.execPath = stdExecPath();
    this.env = environment();
    this.platform = stdPlatform();
    this.arch = stdArch();
    this.pid = stdPid();
    this.ppid = stdPpid();
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

  /** `[seconds, nanoseconds]` on a monotonic clock (see `hrtimePair`). */
  hrtime(): number[] {
    return hrtimePair();
  }

  /** Ends the process now with `code`. A missing argument is the function `exit` below: an
   * omitted method parameter is the same argc as a call with no receiver (docs/VALUE.md §4.16). */
  exit(code: number): never {
    stdExit(statusOf(code));
    throw new Error('unreachable: std/process.exit returned');
  }
}

const processObject = new Process();

// One pattern, not one `export const name = processObject.name` per member: those copies are one
// clone of each other (jscpd, identifier-insensitive). The bindings are the instance's own.
export const { argv, execPath, env, platform, arch, pid, ppid } = processObject;

export function cwd(): string {
  return stdCwd();
}

export function memoryUsage(): MemoryUsage {
  return new MemoryUsage(stdMemoryUsage().rss);
}

export function hrtime(): number[] {
  return hrtimePair();
}

/** Ends the process now with `code`, else `exitCode`, else 0. */
export function exit(code?: number): never {
  stdExit(statusOf(code ?? processObject.exitCode ?? 0));
  throw new Error('unreachable: std/process.exit returned');
}

export default processObject;
