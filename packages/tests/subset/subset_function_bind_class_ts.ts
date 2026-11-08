// @mode: ts
// @verdict: not-yet
// @code: STA1214
// SUBSET.md: Functions -- `bind` on a class is refused by name: `new` on a class-typed value
// builds the instance descriptor directly, so the bound arguments would be lost (plan/T34).

class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}
const AtOne = Point.bind(undefined, 1);
console.log(typeof AtOne);
