// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Functions -- `Function.prototype.bind` builds a bound closure whose env holds
// the receiver in slot 0 and the target in slot 1 (docs/VALUE.md §4.16, plan.md §8 step
// 12e). A method value (`const f = o.m`) is the receiver-DROPPING half and has landed;
// `bind` is the INSERTING half and stays not-yet. `call`/`apply` ride with it.

function add(a, b) {
  return a + b;
}
const bound = add.bind(undefined, 1);
console.log(bound(2));
