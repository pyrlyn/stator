// `node:crypto` (plan.md §11c T11.6): the members live in `internal/crypto.ts`, and the default
// export is that module's namespace, as `node:fs` does it, so a new member needs no second listing
// here.

import * as crypto from './internal/crypto.ts';

export * from './internal/crypto.ts';

export default crypto;
