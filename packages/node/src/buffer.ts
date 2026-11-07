// `node:buffer` (plan.md §11c T11.6): the class lives in `internal/buffer.ts`. A class is not a
// value in Stator's subset, so a namespace object cannot hold it (`moduleNamespaceToHType`): there
// is no default export and `require('buffer')` is not landed until class objects are. The named
// import and the free `Buffer` under `--node` are the class itself.

export { Buffer } from './internal/buffer.ts';
