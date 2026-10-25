// T27: `typeof C` / `typeof K` on a class name, alias, or bound expression folds to
// Node's `"function"` (docs/VALUE.md §4.26). No class object is built — the same
// compile-time fold `C.name` uses. `C.prototype` stays not-yet and is not in this fixture.

class Point {
  x: number = 1;
  static count: number = 0;
}

console.log(typeof Point);
const K = Point;
console.log(typeof K);
const J = K;
console.log(typeof J);

const Expr = class Inner {
  m(): number {
    return 1;
  }
};
console.log(typeof Expr);

const Anon = class {
  n(): number {
    return 2;
  }
};
console.log(typeof Anon);

class Dot extends Point {
  label: string = 'dot';
}
console.log(typeof Dot);
const DK = Dot;
console.log(typeof DK);

export default class Def {
  z: number = 2;
}
console.log(typeof Def);
