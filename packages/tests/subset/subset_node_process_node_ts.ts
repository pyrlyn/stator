// @mode: ts
// @verdict: dynamic
// @node: true
// SUBSET.md: node:process under --node — the N1 slice over std/process and std/env; dynamic
// because `env` is a `Record<string, string | undefined>` index and `exitCode` is
// `number | undefined`, both unions the HIR types as Unknown.
import process from 'node:process';

console.log(process.platform, process.argv.length >= 2, process.exitCode);
