// Node-side bindings for the stat step-1 example: the same accessor calls the
// Stator side makes as direct C calls, spelled with `fs.statSync`. Size is
// exact on both sides; mtime crosses as whole seconds (the shim returns
// `(double)st.st_mtime`), so the mirror floors `mtimeMs / 1000`. A missing
// file is -1 on both — data, not a throw.
import { statSync } from 'node:fs';

type Bindings = Record<string, unknown>;
const bindings = globalThis as unknown as Bindings;

bindings['statSize'] = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
};
bindings['statMtime'] = (path: string): number => {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return -1;
  }
};
