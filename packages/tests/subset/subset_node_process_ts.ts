// @mode: ts
// @verdict: error
// @code: STA0012
// SUBSET.md: node:process — without --node the global `process` is undeclared. `std/process` is
// the non-Node spelling.

console.log(process.pid);
