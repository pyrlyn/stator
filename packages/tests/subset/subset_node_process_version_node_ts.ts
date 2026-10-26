// @mode: ts
// @verdict: not-yet
// @code: STA1214
// @node: true
// SUBSET.md: node:process under --node — `version` is a member Node's module has and packages/node
// has not landed, so it names T11.6.

import { version } from 'node:process';

console.log(version);
