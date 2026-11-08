// `node:buffer` (plan.md §11c T11.6): the class lives in `internal/buffer.ts`. A static called
// through a class object is not yet supported (plan-notes 399), and every use of `Buffer` calls
// one, so there is no default export and `require('buffer')` is not landed. The named import and
// the free `Buffer` under `--node` are the class itself (plan-notes 400).

export { Buffer } from './internal/buffer.ts';
