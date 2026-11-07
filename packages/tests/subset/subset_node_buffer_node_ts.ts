// @mode: ts
// @verdict: dynamic
// @node: true
// SUBSET.md: node:buffer under --node — `Buffer` is packages/node's strict TypeScript class that
// extends `Uint8Array` (plan/T11.6a), imported by name or read as the global `Buffer`; dynamic
// because its optional parameters are `T | undefined` unions and `isBuffer` takes `unknown`.

import { Buffer } from 'node:buffer';

const named = Buffer.from('hi', 'utf8');
const global = Buffer.concat([named, Buffer.alloc(1)]);
console.log(named.toString('hex'), global.length, global[0], Buffer.isBuffer(global));
