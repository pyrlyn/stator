// `node:os` members (plan.md §11c T11.6) over `std/os`, whose answers are already the pinned
// Node's (docs/STD.md §5), so nothing here re-derives them. Gaps: `cpus`, `freemem`, `loadavg`,
// `uptime`, `networkInterfaces`, `userInfo`, `getPriority`/`setPriority` and `constants` need
// backings `std/os` does not have yet, and stay `STA1214`.

import { cpuCount, eol, kernelName, kernelVersion, totalMemory } from 'std/os';

// Members whose `std/os` name and answer are already Node's, re-exported as they are.
export { arch, homedir, hostname, machine, platform, release, tmpdir } from 'std/os';

export const EOL: string = eol;

/** Every POSIX host has the same null device. */
export const devNull = '/dev/null';

export function availableParallelism(): number {
  return cpuCount();
}

/** Every target Stator builds for (arm64 and x64) is little-endian. */
export function endianness(): string {
  return 'LE';
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
