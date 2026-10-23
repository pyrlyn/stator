// @mode: js
// @verdict: dynamic
// @node: true
// SUBSET.md: node:process under --node, js mode — the same N1 slice through the dynamic
// representation.
import process from 'node:process';

console.log(process.platform, process.argv.length >= 2, process.exitCode);
