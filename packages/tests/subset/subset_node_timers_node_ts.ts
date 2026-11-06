// @mode: ts
// @verdict: dynamic
// @node: true
// SUBSET.md: node:timers under --node — the global timer functions, imported by the frontend.

const t = setTimeout(() => console.log('late'), 1);
setImmediate(() => console.log('soon'));
clearTimeout(t);
