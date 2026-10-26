// @mode: ts
// @verdict: dynamic
// @node: true
// SUBSET.md: node:process under --node — packages/node's strict TypeScript over std/process,
// std/env, std/os and std/io, also reachable as the global `process` (the frontend imports it);
// dynamic because `env` is a string-keyed record and `stdout.write` takes a union.

import { argv } from 'node:process';

process.env['STATOR_SUBSET'] = '1';
console.log(argv.length > 1, process.env['STATOR_SUBSET'], process.stdout.write('x\n'));
