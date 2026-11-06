// `node:os` members (plan.md §11c T11.6) over `std/os`, whose answers are already the pinned
// Node's (docs/STD.md §5), so nothing here re-derives them. Gaps: `cpus`, `freemem`, `loadavg`,
// `uptime`, `networkInterfaces`, `userInfo`, `getPriority`/`setPriority` and `constants` need
// backings `std/os` does not have yet, and stay `STA1214`.

import {
  arch as stdArch,
  cpuCount,
  eol,
  homedir as stdHomedir,
  hostname as stdHostname,
  kernelName,
  kernelVersion,
  machine as stdMachine,
  platform as stdPlatform,
  release as stdRelease,
  tmpdir as stdTmpdir,
  totalMemory,
} from 'std/os';

export const EOL: string = eol;

/** Every POSIX host has the same null device. */
export const devNull = '/dev/null';

export function arch(): string {
  return stdArch();
}

export function availableParallelism(): number {
  return cpuCount();
}

/** Every target Stator builds for (arm64 and x64) is little-endian. */
export function endianness(): string {
  return 'LE';
}

export function homedir(): string {
  return stdHomedir();
}

export function hostname(): string {
  return stdHostname();
}

export function machine(): string {
  return stdMachine();
}

export function platform(): string {
  return stdPlatform();
}

export function release(): string {
  return stdRelease();
}

export function tmpdir(): string {
  return stdTmpdir();
}

export function totalmem(): number {
  return totalMemory();
}

export function type(): string {
  return kernelName();
}

export function version(): string {
  return kernelVersion();
}
