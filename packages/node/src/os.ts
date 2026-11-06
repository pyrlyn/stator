// `node:os` (plan.md §11c T11.6): the members live in `internal/os.ts`, and the default export is
// that module's namespace, as `node:fs` does it, so a new member needs no second listing here.

import * as os from './internal/os.ts';

export * from './internal/os.ts';

export default os;
