// @mode: js
// @verdict: static
// @node: true
// SUBSET.md: node:os under --node — the bare specifier and the default export.

import os from 'os';

console.log(os.platform(), os.endianness());
