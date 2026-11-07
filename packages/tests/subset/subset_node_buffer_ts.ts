// @mode: ts
// @verdict: error
// @code: STA0012
// SUBSET.md: node:buffer — without --node the global `Buffer` is undeclared. `Uint8Array` and
// `std/text` are the non-Node spellings.

console.log(Buffer.from('x').length);
