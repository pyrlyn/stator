// @mode: js
// @verdict: dynamic
// @node: true
// SUBSET.md: node:process under --node — the global `process` with no import, its env written
// and deleted, and nextTick with arguments.

process.env.STATOR_SUBSET = '1';
delete process.env.STATOR_SUBSET;
process.nextTick((a) => console.log(a), process.argv.length > 1);
