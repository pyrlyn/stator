// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Object destructuring
// Object rest over a type with methods stays not-yet (I1 residue); the diagnostic
// names it precisely.

class C {
  a = 1;
  m(): number {
    return this.a;
  }
}
const c = new C();
const { a, ...rest } = c;
export { rest };
