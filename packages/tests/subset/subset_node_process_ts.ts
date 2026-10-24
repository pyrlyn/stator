// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: node:process — without --node, `node:*` names the flag (docs/MODES.md §6).
import process from 'node:process';

console.log(process.platform);
