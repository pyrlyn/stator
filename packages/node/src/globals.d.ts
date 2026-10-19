// The Node platform's globals and global types (plan.md §11c T11.5, T11.6): a root file of every
// `--node` program, beside the compiler's own `stator.globals.d.ts`. A module, so that the
// `process` type is an import; everything it declares is global. The import is type-only, so it
// is not a runtime edge: a program pulls `node:process` in only when it reads `process` or
// imports the module (frontend/location.ts).

import type { Process } from './process.ts';

declare global {
  /** `import.meta` under `--node`: the module's location, resolved at run time beside the
   * executable (docs/MODES.md §6). */
  interface ImportMeta {
    readonly url: string;
    readonly filename: string;
    readonly dirname: string;
  }

  /** The function `createRequire` returns. Its answer is typed the way `JSON.parse`'s is, since
   * the id is a run-time string: in `ts` mode the caller annotates it; in `js` mode it is
   * dynamic. */
  interface NodeRequire {
    (id: string): ReturnType<typeof JSON.parse>;
  }

  /** The global `process`: the `node:process` module's default export, which the frontend
   * imports into every file that reads it (`frontend/location.ts`). */
  const process: Process;
}
