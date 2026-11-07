// @mode: ts
// @verdict: dynamic
// @node: true
// SUBSET.md: node:crypto under --node — `createHash`, `Hash` and `hash` over `std/hash`; dynamic
// because `update` and `hash` take `string | Uint8Array` and `digest` answers `string | Buffer`.

import crypto, { createHash, hash } from 'node:crypto';

const h = createHash('sha256').update('abc');
console.log(h.digest('hex'), crypto.createHash('sha256').digest('base64'), hash('sha1', 'abc'));
