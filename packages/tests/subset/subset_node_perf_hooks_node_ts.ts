// @mode: ts
// @verdict: dynamic
// @node: true
// SUBSET.md: node:perf_hooks under --node — `performance` imported and as the global.

import { performance as perf } from 'node:perf_hooks';

perf.mark('a');
console.log(perf === performance, perf.measure('m', 'a').name);
