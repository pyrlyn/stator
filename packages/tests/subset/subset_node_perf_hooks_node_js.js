// @mode: js
// @verdict: dynamic
// @node: true
// SUBSET.md: node:perf_hooks under --node — the bare specifier and the default export.

import perfHooks from 'perf_hooks';

console.log(typeof perfHooks.performance.now());
