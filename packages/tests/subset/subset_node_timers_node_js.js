// @mode: js
// @verdict: dynamic
// @node: true
// SUBSET.md: node:timers under --node — the bare specifier and the default export.

import timers from 'timers';

timers.setTimeout(() => console.log('late'), 1);
