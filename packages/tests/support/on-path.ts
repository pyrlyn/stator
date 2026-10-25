import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Absolute path of executable `name` on PATH. Scans PATH itself so `name` never reaches a shell. */
export function onPath(name: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}
