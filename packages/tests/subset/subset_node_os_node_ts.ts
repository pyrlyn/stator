// @mode: ts
// @verdict: static
// @node: true
// SUBSET.md: node:os under --node — the members tsc reads, over std/os; static, since
// every answer is a string or a number.

import { EOL, platform, type } from 'node:os';

console.log(JSON.stringify(EOL), platform(), type());
