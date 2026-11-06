// @mode: ts
// @verdict: error
// @code: STA0012
// SUBSET.md: node:timers — without --node the global `setTimeout` is undeclared.

setTimeout(() => console.log('late'), 1);
