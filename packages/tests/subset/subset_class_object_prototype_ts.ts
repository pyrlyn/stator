// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Class-object reads -- `C.prototype` stays not-yet with the named Phase-8 code
// ("the prototype surface"); T27 lands `C.name` + static reads and leaves this behind.

class C {
  x: number = 1;
}
const K = C;
console.log(K.prototype);
