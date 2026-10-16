// @mode: js
// @verdict: dynamic
// SUBSET.md: rest parameters (call-side spread needs a dynamic argv)
// A parameter annotated `unknown`, or a rest parameter annotated `unknown[]`, claims nothing the
// call edge could check, so a spread into it is not refused like subset_spread_annotated_callee_js
// (plan-notes 324). `node:process`'s `nextTick` calls its callback this way.
function show(label: unknown, ...rest: unknown[]): string {
  return String(label) + ":" + String(rest.length);
}
const xs: unknown[] = JSON.parse('[1, 2, 3]');
console.log(show(...xs));
