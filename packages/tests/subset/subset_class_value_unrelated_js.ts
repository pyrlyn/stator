// @mode: js
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Class-object reads -- an unrelated class where another is expected, in a typed
// file of a js-mode graph: the same layout refusal as in ts mode (T27).

class C {
  x: number = 1;
}
class E {
  x: number = 2;
}
let K = C;
K = E;
console.log(new K().x);
