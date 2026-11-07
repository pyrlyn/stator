// @mode: js
// @verdict: dynamic
// @node: true
// SUBSET.md: node:buffer under --node — the global `Buffer` with no import, called with untyped
// values; its methods read off an untyped view keep their receiver.

let input;
input = [104, 105];
const view = Buffer.from(input);
console.log(view.toString('utf8', 1), Buffer.byteLength('hi'), Buffer.isBuffer(view));
