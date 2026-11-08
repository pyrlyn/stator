// @mode: ts
// @verdict: dynamic
// SUBSET.md: Functions -- `Function.prototype.bind` builds a bound closure whose three-slot
// env holds the receiver, the target and the bound arguments (docs/VALUE.md §4.16, plan/T34).
// A method value (`const f = o.m`) DROPS a receiver; `bind` INSERTS one. The result is an
// untyped function value, so the call through it is dynamic in both modes.

function add(a: number, b: number): number {
  return a + b;
}
const bound = add.bind(undefined, 1);
console.log(bound(2));
