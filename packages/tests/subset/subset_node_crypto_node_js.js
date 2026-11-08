// @mode: js
// @verdict: dynamic
// @node: true
// SUBSET.md: node:crypto under --node — the bare specifier and the default export, called with an
// untyped value, as `tsc` hashes its text.

import crypto from 'crypto';

let text;
text = 'abc';
const h = crypto.createHash('sha256');
h.update(text);
console.log(h.digest('hex'));
